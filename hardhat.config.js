require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { SEPOLIA_RPC_URL, ADMIN_PRIVATE_KEY, GATEWAY_PRIVATE_KEY } = process.env;
const sepoliaAccounts = [ADMIN_PRIVATE_KEY, GATEWAY_PRIVATE_KEY].filter(Boolean);

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    // HARDHAT_BLOCK_INTERVAL_MS emulates a public chain's slot time (e.g. 12000 for Ethereum) on `hardhat node`.
    hardhat: process.env.HARDHAT_BLOCK_INTERVAL_MS
      ? { mining: { auto: false, interval: Number(process.env.HARDHAT_BLOCK_INTERVAL_MS) } }
      : {},
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    ...(SEPOLIA_RPC_URL
      ? { sepolia: { url: SEPOLIA_RPC_URL, chainId: 11155111, accounts: sepoliaAccounts } }
      : {}),
  },
  mocha: { timeout: 120000 },
};

// ---------------------------------------------------------------------------
// Offline compilation (optional): if SOLCJS_PATH points to a soljson.js for
// solc 0.8.24 (e.g. node_modules/solc/soljson.js after `npm i --no-save solc@0.8.24`),
// Hardhat uses it instead of downloading the compiler. Not needed on a normal machine.
// ---------------------------------------------------------------------------
if (process.env.SOLCJS_PATH) {
  const { subtask } = require("hardhat/config");
  const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
    if (args.solcVersion === "0.8.24") {
      return {
        compilerPath: require("path").resolve(process.env.SOLCJS_PATH),
        isSolcJs: true,
        version: args.solcVersion,
        longVersion: "0.8.24+commit.e11b9ed9",
      };
    }
    return runSuper();
  });
}
