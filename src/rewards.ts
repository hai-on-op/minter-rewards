import { config } from './config';
import { getAccumulatedRate } from './initial-state';
import {
  LpPosition,
  RewardEvent,
  RewardEventType,
  UserAccount,
  UserList,
  Rates
} from './types';
import { getOrCreateUser } from './utils';
import { provider } from './chain';
import { sanityCheckAllUsers } from './sanity-checks';
import { getStakingWeight } from './staking-weight';
import { getPoolState, getRedemptionPriceFromTimestamp } from './subgraph';
import * as fs from 'fs';
import { get } from 'http';
import { getBridgedTokensAtBlock } from './bridge/getBridgedTokensAtBlock';

export const CTYPES = ['WSTETH', 'WETH', 'TBTC', 'RETH', 'OP', 'APXETH'];

export const processRewardEvent = async (
  users: UserList,
  events: RewardEvent[],
  rewardAmount: number,
  withBridge: boolean
): Promise<UserList> => {
  const eventsBasedUsers = events
    .filter(e => e.address)
    .map(e => e.address) as string[];

  // Starting and ending of the campaign
  const startBlock = config().START_BLOCK;
  const endBlock = config().END_BLOCK;
  const startTimestamp = (await provider.getBlock(startBlock)).timestamp;
  const endTimestamp = (await provider.getBlock(endBlock)).timestamp;

  // Constant amount of reward distributed per second
  const rewardRate = rewardAmount / (endTimestamp - startTimestamp);

  // Ongoing Total supply of weight
  let totalStakingWeight = sumAllWeights(users);

  // Ongoing cumulative reward per weight over time
  let rewardPerWeight = 0;

  let updateRewardPerWeight = (evtTime: number) => {
    if (totalStakingWeight > 0) {
      const deltaTime = evtTime - timestamp;
      rewardPerWeight += (deltaTime * rewardRate) / totalStakingWeight;
    }
  };

  // Ongoing time
  let timestamp = startTimestamp;

  // Ongoing accumulated rate
  const rates: Rates = {};
  for (let i = 0; i < CTYPES.length; i++) {
    const cType = CTYPES[i];
    const cTypeRate = await getAccumulatedRate(startBlock, cType);
    rates[cType] = cTypeRate;
  }

  // Ongoing uni v3 sqrtPrice
  let sqrtPrice = (
    await getPoolState(startBlock, config().UNISWAP_POOL_ADDRESS)
  ).sqrtPrice;

  // Ongoing redemption price
  let redemptionPrice: number = 1; // Initialize with default value

  let redemptionPriceLastUpdate = 0;
  // ===== Main processing loop ======

  console.log(
    `Distributing ${rewardAmount} at a reward rate of ${rewardRate}/sec between ${startTimestamp} and ${endTimestamp}`
  );
  console.log('Applying all events...');
  // Main processing loop processing events in chronologic order that modify the current reward rate distribution for each user.

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    if (i % 1000 === 0 && i > 0) console.log(`  Processed ${i} events`);

    // Update the redemption price, only async task in this processing loop
    if (redemptionPriceLastUpdate + 3600 * 24 <= event.timestamp) {
      redemptionPrice = await getRedemptionPriceFromTimestamp(event.timestamp);
      redemptionPriceLastUpdate = event.timestamp;
    }

    updateRewardPerWeight(event.timestamp);

    const rewardsDistributed = rewardRate * (event.timestamp - startTimestamp);

    // Increment time
    timestamp = event.timestamp;

    // The way the rewards are credited is different for each event type
    switch (event.type) {
      case RewardEventType.DELTA_DEBT: {
        const user = getOrCreateUser(event.address ?? '', users);
        earn(user, rewardPerWeight);

        // setting user totalBridgedTokens
        user.totalBridgedTokens = getBridgedTokensAtBlock(
          event.address,
          event.cType,
          event.createdAtBlock
        );

        const accumulatedRate = rates[event.cType as string];

        // Convert to real debt after interests and update the debt balance
        const adjustedDeltaDebt = (event.value as number) * accumulatedRate;
        user.debt += adjustedDeltaDebt;

        user.collateral += event.complementaryValue;

        // Ignore Dusty debt
        if (user.debt < 0 && user.debt > -0.4) {
          user.debt = 0;
        }

        user.stakingWeight = getStakingWeight(
          user.debt,
          user.collateral,
          user.totalBridgedTokens,
          withBridge
        );

        break;
      }
      case RewardEventType.UPDATE_ACCUMULATED_RATE: {
        // Update accumulated rate increases everyone's debt by the rate multiplier
        const rateMultiplier = event.value as number;
        const cTypeRate = rates[event.cType as string];
        rates[event.cType as string] = cTypeRate + rateMultiplier;

        // setting user totalBridgedTokens
        Object.values(users).map(
          u =>
            (u.totalBridgedTokens = getBridgedTokensAtBlock(
              u.address,
              event.cType,
              event.createdAtBlock
            ))
        );

        // First credit all users
        Object.values(users).map(u => earn(u, rewardPerWeight));

        // Update everyone's debt
        Object.values(users).map(u => (u.debt *= rateMultiplier + 1));

        Object.values(users).map(u => {
          // calculating userEffectiveBridgedTokens
          const userEffectiveBridgedTokens = u.totalBridgedTokens; //- u.usedBridgedTokens;

          u.stakingWeight = getStakingWeight(
            u.debt,
            u.collateral,
            userEffectiveBridgedTokens,
            withBridge
          );
        });
        break;
      }
      default:
        throw Error('Unknown event');
    }

    sanityCheckAllUsers(users, event);

    // Individual user check, uncomment to create a report
    // const u = "0x00000...".toLowerCase()
    // earn(users[u], rewardPerWeight)
    // fs.appendFileSync("user.csv",`${new Date(timestamp * 1000).toISOString()},${users[u].debt},${users[u].lpPositions.reduce(
    //   (acc, p) => acc + getPositionSize(p, sqrtPrice, redemptionPrice),
    //   0
    // )},${users[u].stakingWeight},${totalStakingWeight},${users[u].earned}\n`)

    // Recalculate the sum of weights since the events the weights

    totalStakingWeight = sumAllWeights(users);
  }

  // Final crediting of all rewards
  updateRewardPerWeight(endTimestamp);
  Object.values(users).map(u => earn(u, rewardPerWeight));

  return users;
};

// Credit reward to a user
const earn = (user: UserAccount, rewardPerWeight: number) => {
  // Credit to the user his due rewards
  user.earned +=
    (rewardPerWeight - user.rewardPerWeightStored) * user.stakingWeight;

  // Store his cumulative credited rewards for next time
  user.rewardPerWeightStored = rewardPerWeight;
};

// Simply sum all the stakingWeight of all users
const sumAllWeights = (users: UserList) =>
  Object.values(users).reduce((acc, user) => {
    return acc + user.stakingWeight;
  }, 0);
