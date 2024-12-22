import { config as envConfig } from "./config";
import { getEvents } from "./get-events";
import { getInitialState } from "./initial-state";
import { processRewardEvent } from "./rewards";
import { UserList } from "./types";

import { exportResults, getSafeOwnerMapping } from "./utils";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const parseArgs = () => {
  return yargs(hideBin(process.argv))
    .option("with-bridge", {
      type: "boolean",
      description: "Run with bridge option",
      default: false,
    })
    .parse();
};

const main = async () => {
  const args = parseArgs();
  const withBridge = !!args["with-bridge"];

  const config = JSON.parse(envConfig().CONFIG);
  const owners = await getSafeOwnerMapping(envConfig().END_BLOCK);

  const rewardTokens = Object.keys(config);
  for (let i = 0; i < rewardTokens.length; i++) {
    const rewardToken = rewardTokens[i];
    console.log("Calculating rewards for token: ", rewardToken);
    const collateralTypes = Object.keys(config[rewardToken]);

    for (let j = 0; j < collateralTypes.length; j++) {
      const cType = collateralTypes[j];
      const rewardAmount = config[rewardToken][cType];
      console.log("...Reward amount: ", rewardAmount);
      console.log("...Collateral type: ", cType);
      const users: UserList = await getInitialState(
        envConfig().START_BLOCK,
        envConfig().END_BLOCK,
        owners,
        cType
      );

      const events = await getEvents(
        envConfig().START_BLOCK,
        envConfig().END_BLOCK,
        owners,
        cType
      );

      await processRewardEvent(users, events, rewardAmount, withBridge);

      await exportResults(users, rewardToken, cType);
    }
  }
};

// Start..
main();
