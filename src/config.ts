import { config as dotenv } from 'dotenv';

dotenv();

export const config = () => {
  const envs = process.env as any;
  return {
    GEB_SUBGRAPH_URL: envs.GEB_SUBGRAPH_URL,
    REWARD_TOKEN: envs.REWARD_TOKEN,
    CONFIG: envs.CONFIG,
    UNISWAP_SUBGRAPH_URL: envs.UNISWAP_SUBGRAPH_URL,
    UNISWAP_POOL_ADDRESS: envs.UNISWAP_POOL_ADDRESS.toLowerCase(),
    RPC_URL: envs.RPC_URL,
    START_BLOCK: Number(envs.START_BLOCK),
    END_BLOCK: Number(envs.END_BLOCK)
  };
};
