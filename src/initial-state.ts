import { config } from "./config";
import { subgraphQuery, subgraphQueryPaginated } from "./subgraph";
import { UserList } from "./types";
import { getExclusionList, getOrCreateUser } from "./utils";
import { CTYPES } from "./rewards";

interface Rates {
  [key: string]: any; // or whatever type the values should be
}

export const getInitialState = async (
  startBlock: number,
  endBlock: number,
  owners: Map<string, string>,
  cType: string
) => {
  // Get all debts
  const debts = await getInitialSafesDebt(startBlock, owners, cType);

  console.log(`Fetched ${debts.length} debt balances`);

  // Add positions
  const users: UserList = {};

  for (let debt of debts) {
    const user = getOrCreateUser(debt.address, users);
    user.debt += debt.debt;
    user.collateral += debt.collateral;
    users[debt.address] = user;
  }

  // Remove accounts from the exclusion list
  const exclusionList = await getExclusionList();
  for (let e of exclusionList) {
    delete users[e];
  }

  // Sanity checks
  for (let user of Object.values(users)) {
    if (
      user.debt == undefined ||
      user.earned == undefined ||
      user.lpPositions == undefined ||
      user.rewardPerWeightStored == undefined ||
      user.stakingWeight == undefined
    ) {
      throw Error(`Inconsistent initial state user ${user}`);
    }
  }

  console.log(
    `Finished loading initial state for ${Object.keys(users).length} users`
  );
  return users;
};

const getInitialSafesDebt = async (
  startBlock: number,
  ownerMapping: Map<string, string>,
  cType: string
) => {
  const debtQuery = `{safes(where: {debt_gt: 0, collateralType: "${cType}"}, first: 1000, skip: [[skip]],block: {number:${startBlock}}) {debt, collateral, safeHandler, collateralType {id}}}`;
  const debtsGraph: {
    debt: number;
    collateral: number;
    safeHandler: string;
    collateralType: {
      id: string;
    };
  }[] = await subgraphQueryPaginated(
    debtQuery,
    "safes",
    config().GEB_SUBGRAPH_URL
  );

  console.log(`Fetched ${debtsGraph.length} debts`);

  // We need the adjusted debt after accumulated rate for the initial state
  const rates: Rates = {};

  for (let i = 0; i < CTYPES.length; i++) {
    const cType = CTYPES[i];
    const cTypeRate = await getAccumulatedRate(startBlock, cType);
    rates[cType] = cTypeRate;
  }

  let debts: { address: string; debt: number; collateral: number }[] = [];
  for (let u of debtsGraph) {
    if (!ownerMapping.has(u.safeHandler)) {
      console.log(`Safe handler ${u.safeHandler} has no owner`);
      continue;
    }
    const cType = u.collateralType.id;
    const cRate = rates[cType];

    const address = ownerMapping.get(u.safeHandler);
    if (address !== undefined) {
      debts.push({
        address: address,
        debt: Number(u.debt) * cRate,
        collateral: Number(u.collateral),
      });
    }
  }

  return debts;
};

export const getAccumulatedRate = async (block: number, cType: string) => {
  return Number(
    (
      await subgraphQuery(
        `{collateralType(id: "${cType}", block: {number: ${block}}) {accumulatedRate}}`,
        config().GEB_SUBGRAPH_URL
      )
    ).collateralType.accumulatedRate
  );
};
