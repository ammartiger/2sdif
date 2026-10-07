//Express and Nodes JS setup
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
require("dotenv").config();
const app = express();
const port = 3000;
const sha1 = require("sha1");
const fs = require("fs-extra");

//logged in as
let user = "";
//For sig verification
const ethUtil = require("ethereumjs-util");
const sigUtil = require("eth-sig-util");
// import * as ethUtil from "ethereumjs-util";
// import * as sigUtil from "eth-sig-util";

//Blockchain Setup
const { ethers } = require("ethers");
const GOERLI_RPC_URL = process.env.GOERLI_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
//used solc compiler to generate fresh ABI and the fs package to read abi file
const abi = fs.readFileSync(
  "./contracts_SimpleStorage_sol_SimpleStorage.abi",
  "utf8"
);
let provider = new ethers.providers.JsonRpcProvider(GOERLI_RPC_URL);
let wallet = new ethers.Wallet(PRIVATE_KEY, provider);
let storage = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);
// Example testing Blockchain call
// addAdmin();
// async function addAdmin() {
//   const currentValue = await storage.addAdmin(
//     "456",
//     "0xb89320878CBD7Df4946Aa81fE4cA800Bb098cDc9",
//     "ffada"
//   );
//   await currentValue.wait(1);
// }
// getAdmin();
// async function getAdmin() {
//   const currentValue = await storage.getAdmin(
//     "0xb89320878CBD7Df4946Aa81fE4cA800Bb098cDc9"
//   );
//   console.log(`Current admin Value is: ${currentValue}`);
//   const patientValue = await storage.getPatient(
//     "0xb89320878CBD7Df4946Aa81fE4cA800Bb098cDc9"
//   );
//   console.log(`Current patient Value is: ${patientValue}`);
// }
// // Where we will keep personal Information about a patient
//use array indexes to separate output from blockchain
let patients = [
  {
    ssn: "2001",
    name: "Ammar Hassan",
    address: "House no 100/3, Block C, Satellite town",
    phone: "03216026940",
    wallet: "0x8Ff2b66dcf4F0849a19481DD5EA4fa9f4647C891",
    doctor: "0xEdD16B9c7ccf81b2D17076c77732f7030865db0B",
    meta: "a9f4541b3566be50550332cd13e031b79fbdf19a",
  },
  {
    ssn: "2002",
    name: "Saad Faisal",
    address: 'S14 Satellite town"',
    phone: "03436026985",
    wallet: "0xe0a95b3457d4A89Ad19A2aD4947d5dB555D175CA",
    doctor: "0x7d131118eb2486B6F178Ee4A4496273CcfF54f48",
    meta: "05a947d8d28023045aaf5a1e255af6d2701bee00",
  },
];
let admin = [
  {
    ssn: "0001",
    name: "Saim Hassan",
    address: "House no 75, Block A, Satellite town",
    phone: "03356025874",
    account: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  },
];
for (let f of admin) {
  const adminMeta = sha1(JSON.stringify(f));
  f.meta = adminMeta;
  // console.log(f.ssn);
  adminToBlockchain(f);
}
console.log(admin);

app.use(cors());

// Configuring body parser middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post("/addpatients", async function (req, res) {
  const per = req.body;
  // addpatients(per);
  const meta = sha1(JSON.stringify(per));
  // console.log(meta);
  per.meta = meta;
  // console.log(per);
  // checking if admin is logged on
  let value = await checkAdmin();
  console.log(value);
  if (value == true) {
    patients.push(per);
    // console.log(patients);
    await patientToBlockchain(per);
    res.send("Patient added to database");
  } else {
    console.log(" Permission denied! You are not admin");
    res.send("Permission denied! You are not admin");
  }
});

async function checkAdmin() {
  const currentValue = await storage.getAdmin(user);
  if (currentValue[0]) {
    console.log(`Current admin Value is: ${currentValue[0]}`);
    return true;
  } else {
    return false;
  }
}

async function patientToBlockchain(per) {
  const currentValue = await storage.addPatient(
    per.ssn,
    per.wallet,
    per.doctor,
    per.meta
  );
  await currentValue.wait(1);
}

async function adminToBlockchain(f) {
  const currentValue = await storage.addAdmin(f.ssn, f.account, f.meta);
  await currentValue.wait(1);
}

// async function addpatients(per) {
//   const meta = sha1(JSON.stringify(per));
//   console.log(meta);
//   per.meta = meta;
//   console.log(per);
//   patients.push(per);
//   console.log(patients);
//   // res.send("Patient is added to the database");
// }
app.get("/patients", (req, res) => {
  res.json(patients);
});

app.get("/admin", (req, res) => {
  res.json(admin);
});

//working on authentication part
function web3_metamask_hash() {
  var hashed_string = "";
  var chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  var total_chars = chars.length;
  for (var i = 0; i < 256; i++) {
    hashed_string += chars.charAt(Math.floor(Math.random() * total_chars));
  }
  return hashed_string;
}

app.get("/getnounce", (req, res) => {
  let hash = web3_metamask_hash();
  console.log(hash);
  res.json(hash);
});

app.post("/loginadmin", function (req, res) {
  const per = req.body;
  console.log(per);

  let usig = per.sign;
  let umsg = per.hello;
  let uwallet = per.wallet.toLowerCase();
  // console.log(`signature=${usig},message=${umsg},account=${uwallet}`);
  const msgBufferHex = ethUtil.bufferToHex(Buffer.from(umsg, "utf8"));
  const calcAddress = sigUtil.recoverPersonalSignature({
    data: msgBufferHex,
    sig: usig,
  });
  console.log(uwallet);
  console.log(calcAddress);
  user = uwallet;
  console.log(`logged in as ${user}`);
  let success = "Logged in successfully";
  let failure = "Failed to verify signature";
  if (uwallet == calcAddress) {
    res.send(success);
  } else {
    res.send(failure);
  }
});

app.listen(port, () => console.log(`Admin API listening on ${port}!`));
