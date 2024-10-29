// For a single user
export type UserAccount = {
  address: string;
  debt: number;
  collateral: number;
  lpPositions: LpPosition[];
  stakingWeight: number;
  rewardPerWeightStored: number;
  earned: number;
  totalBridgedTokens: number;
  usedBridgedTokens: number;
};

// Main data structure
export type UserList = {
  [address: string]: UserAccount;
};

export type Rates = {
  [key: string]: number; // or whatever type the values should be
};

export enum RewardEventType {
  DELTA_DEBT,
  POOL_POSITION_UPDATE,
  POOL_SWAP,
  UPDATE_ACCUMULATED_RATE
}

export type RewardEvent = {
  type: RewardEventType;
  address?: string;
  value: number | LpPosition;
  complementaryValue?: number;
  timestamp: number;
  createdAtBlock: number;
  logIndex: number;
  cType?: string;
};

export type LpPosition = {
  tokenId: number;
  upperTick: number;
  lowerTick: number;
  liquidity: number;
};
