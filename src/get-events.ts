import { zeroPad } from "ethers/lib/utils";
import { blockToTimestamp } from "./chain";
import { config } from "./config";
import { subgraphQueryPaginated } from "./subgraph";
import { RewardEvent, RewardEventType } from "./types";
import { getExclusionList, getSafeOwnerMapping, NULL_ADDRESS } from "./utils";

export const getEvents = async (
  startBlock: number,
  endBlock: number,
  owners: Map<string, string>,
  cType: string
) => {
  console.log(`Fetch events ...`);

  const res = await Promise.all([
    getSafeModificationEvents(startBlock, endBlock, owners, cType),
    getUpdateAccumulatedRateEvent(startBlock, endBlock, cType),
  ]);

  // Merge all events
  let events = res.reduce((a, b) => a.concat(b), []);

  // Filter out events involving the exclusion list
  // Remove accounts from the exclusion list
  const exclusionList = await getExclusionList();
  events = events.filter(
    (e) => !e.address || !exclusionList.includes(e.address)
  );

  // Sort first by timestamp then by logIndex
  events = events.sort((a, b) => {
    if (a.timestamp > b.timestamp) {
      return 1;
    } else if (a.timestamp < b.timestamp) {
      return -1;
    } else {
      if (a.logIndex > b.logIndex) {
        return 1;
      } else {
        return -1;
      }
    }
  });

  console.log(`Fetched a total of ${events.length} events`);

  // Sanity checks
  for (let e of events) {
    if (
      !e ||
      e.logIndex == undefined ||
      !e.timestamp ||
      e.type == undefined ||
      !e.value == undefined
    ) {
      throw Error(`Inconsistent event: ${JSON.stringify(e)}`);
    }

    if (
      e.type === RewardEventType.POOL_POSITION_UPDATE ||
      // @ts-ignore
      e.type === RewardEventType.DELTA_DEBT
    ) {
      if (!e.address) {
        throw Error(`Inconsistent event: ${JSON.stringify(e)}`);
      }
    } else {
      if (e.address) {
        throw Error(`Inconsistent event: ${JSON.stringify(e)}`);
      }
    }
  }

  return events;
};

const getSafeModificationEvents = async (
  start: number,
  end: number,
  ownerMapping: Map<string, string>,
  cType: string
): Promise<RewardEvent[]> => {
  // We several kind of modifications

  type SubgraphSafeModification = {
    id: string;
    deltaDebt: string;
    createdAt: string;
    createdAtBlock: string;
    safeHandler: string;
    collateralType?: {
      id: string;
    };
  };

  // Main event to modify a safe
  const safeModificationQuery = `{
      modifySAFECollateralizations(where: {createdAtBlock_gte: ${start}, collateralType: "${cType}", createdAtBlock_lte: ${end}, deltaDebt_not: 0}, first: 1000, skip: [[skip]]) {
        id
        deltaDebt
        safeHandler
        createdAt
        createdAtBlock
        collateralType {
          id
        }
      }
    }`;

  const safeModifications: SubgraphSafeModification[] =
    await subgraphQueryPaginated(
      safeModificationQuery,
      "modifySAFECollateralizations",
      config().GEB_SUBGRAPH_URL
    );

  // Event used in liquidation
  const confiscateSAFECollateralAndDebtsQuery = `{
    confiscateSAFECollateralAndDebts(where: {createdAtBlock_gte: ${start}, collateralType: "${cType}", createdAtBlock_lte: ${end}, deltaDebt_not: 0}, first: 1000, skip: [[skip]]) {
      id
      deltaDebt
      safeHandler
      createdAt
      createdAtBlock
      collateralType {
        id
      }
    }
  }`;

  const confiscateSAFECollateralAndDebts: SubgraphSafeModification[] =
    await subgraphQueryPaginated(
      confiscateSAFECollateralAndDebtsQuery,
      "confiscateSAFECollateralAndDebts",
      config().GEB_SUBGRAPH_URL
    );

  // Event transferring debt, rarely used
  const transferSAFECollateralAndDebtsQuery = `{
    transferSAFECollateralAndDebts(where: {createdAtBlock_gte: ${start}, collateralType: "${cType}", createdAtBlock_lte: ${end}, deltaDebt_not: 0}, first: 1000, skip: [[skip]]) {
      id
      deltaDebt
      createdAt
      createdAtBlock
      srcHandler
      dstHandler
      collateralType {
        id
      }
    }
  }`;

  const transferSAFECollateralAndDebts: {
    id: string;
    deltaDebt: string;
    createdAt: string;
    createdAtBlock: string;
    srcHandler: string;
    dstHandler: string;
  }[] = await subgraphQueryPaginated(
    transferSAFECollateralAndDebtsQuery,
    "transferSAFECollateralAndDebts",
    config().GEB_SUBGRAPH_URL
  );

  const transferSAFECollateralAndDebtsProcessed: SubgraphSafeModification[] =
    [];
  for (let t of transferSAFECollateralAndDebts) {
    transferSAFECollateralAndDebtsProcessed.push({
      id: t.id,
      deltaDebt: t.deltaDebt,
      safeHandler: t.dstHandler,
      createdAt: t.createdAt,
      createdAtBlock: t.createdAtBlock,
    });

    transferSAFECollateralAndDebtsProcessed.push({
      id: t.id,
      deltaDebt: (-1 * Number(t.deltaDebt)).toString(),
      safeHandler: t.srcHandler,
      createdAt: t.createdAt,
      createdAtBlock: t.createdAtBlock,
    });
  }

  // Merge all the different kind of modifications
  const allModifications = safeModifications
    .concat(confiscateSAFECollateralAndDebts)
    .concat(transferSAFECollateralAndDebtsProcessed);

  const events: RewardEvent[] = [];
  for (let u of allModifications) {
    if (!ownerMapping.has(u.safeHandler)) {
      console.log(`Safe handler ${u.safeHandler} has no owner`);
      continue;
    }

    events.push({
      type: RewardEventType.DELTA_DEBT,
      value: Number(u.deltaDebt),
      address: ownerMapping.get(u.safeHandler),
      logIndex: getLogIndexFromId(u.id),
      timestamp: Number(u.createdAt),
      createdAtBlock: Number(u.createdAtBlock),
      cType: u.collateralType?.id,
    });
  }

  console.log(
    `  Fetched ${events.length} safe modifications events including ${safeModifications.length} standard safe modification, ${confiscateSAFECollateralAndDebts.length} safe confiscations, ${transferSAFECollateralAndDebts.length} transfer safe debt`
  );
  return events;
};

const getUpdateAccumulatedRateEvent = async (
  start: number,
  end: number,
  cType: string
): Promise<RewardEvent[]> => {
  const query = `{
            updateAccumulatedRates(orderBy: accumulatedRate, orderDirection: desc where: {createdAtBlock_gte: ${start}, collateralType: "${cType}", createdAtBlock_lte: ${end}}, first: 1000, skip: [[skip]]) {
              id
              rateMultiplier
              createdAt
              createdAtBlock
              collateralType {
                id
              }
            }
        }`;

  const data: {
    id: string;
    rateMultiplier: string;
    createdAt: string;
    createdAtBlock: string;
    collateralType: { id: string };
  }[] = await subgraphQueryPaginated(
    query,
    "updateAccumulatedRates",
    config().GEB_SUBGRAPH_URL
  );

  const events = data.map((x) => ({
    type: RewardEventType.UPDATE_ACCUMULATED_RATE,
    cType: x.collateralType.id,
    value: Number(x.rateMultiplier),
    logIndex: getLogIndexFromId(x.id),
    timestamp: Number(x.createdAt),
    createdAtBlock: Number(x.createdAtBlock),
  }));
  console.log(`  Fetched ${events.length} accumulated rate events`);
  return events;
};

const getLogIndexFromId = (id: string) => {
  const matches = id.split("-");

  if (matches.length < 2 || isNaN(Number(matches[1]))) {
    throw Error("Invalid log index");
  }

  return Number(matches[1]);
};
