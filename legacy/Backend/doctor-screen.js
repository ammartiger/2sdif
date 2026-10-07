const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();
const app = express();
const port = 3001;
const sha1 = require("sha1");
const fs = require("fs-extra");
//logged in as
let user = "";
//For sig verification
const ethUtil = require("ethereumjs-util");
const sigUtil = require("eth-sig-util");
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
getAdmin();
async function getAdmin() {
  const currentValue = await storage.getDoctor(
    "0xEdD16B9c7ccf81b2D17076c77732f7030865db0B"
  );
  console.log(`Current Docotor Value is: ${currentValue}`);
  const phiValue = await storage.getPhi(
    "0xEdD16B9c7ccf81b2D17076c77732f7030865db0B"
  );
  console.log(`Current phi Value is: ${phiValue}`);
  const subValue = await storage.getSub("123");
  console.log(`Current prescription Value is: ${subValue}`);
}

// Where we will keep personal Information about a Doctor
let doctors = [
  {
    ssn: "1001",
    name: "Jugan Kazmi",
    address: "F-11, Islamabad",
    phone: "03258745894",
    wallet: "0xEdD16B9c7ccf81b2D17076c77732f7030865db0B",
    meta: "c519606dc066f5ddc9ca21f5b923cef7889bf9c8",
  },
  {
    ssn: "1002",
    name: "Saad Hassan",
    address: "F-12, Lahore",
    phone: "03254865895",
    wallet: "0x7d131118eb2486B6F178Ee4A4496273CcfF54f48",
    meta: "432808a8a5f418e8dcc7276d10d086fc0623884e",
  },
];

app.use(cors());

// Configuring body parser middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post("/adddoctors", async function (req, res) {
  const per = req.body;
  const meta = sha1(JSON.stringify(per));
  console.log(meta);
  per.meta = meta;
  console.log(per);
  //check admin priviliges
  let value = await checkAdmin();
  console.log(value);
  if (value == true) {
    doctors.push(per);
    console.log(doctors);
    await doctorToBlockchain(per);
    res.send("Doctor is added to the database");
  } else {
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

async function doctorToBlockchain(per) {
  const currentValue = await storage.addDoctor(per.ssn, per.wallet, per.meta);
  await currentValue.wait(1);
}

app.get("/doctors", (req, res) => {
  res.json(doctors);
});

let phi = [
  {
    ssn: "2001",
    name: "Ammar Hassan",
    Diseases: "Fever",
    healthPlan: "Annual",
    responsibleClinician: "0xEdD16B9c7ccf81b2D17076c77732f7030865db0B",
    payment: "Credit card",
    wallet: "0xb89320878CBD7Df4946Aa81fE4cA800Bb098cDc9",
    meta: "a2b10568667b773e1bcf304c4be42e98d9ac97d2",
  },
  {
    ssn: "2002",
    name: "Saad Faisal",
    Diseases: "Fever",
    healthPlan: "Annual",
    responsibleClinician: "0x7d131118eb2486B6F178Ee4A4496273CcfF54f48",
    payment: "Credit card",
    wallet: "0xb89320878CBD7Df4946Aa81fE4cA800Bb098cDc9",
    meta: "05ce427911a3f06d6e99c844e3b3d5a0fcd83fc1",
  },
];
app.post("/addpatientshealthdata", async function (req, res) {
  const per = req.body;
  const meta = sha1(JSON.stringify(per));
  // console.log(meta);
  per.meta = meta;
  //get the integrity information from cloud
  let verifyHash = await cloudVerify(per.ssn, per.meta);
  console.log(`result from function is ${verifyHash}`);
  if (verifyHash == 1) {
    // getting the responsible cllinician from blockchain
    let currentDoc = await checkDoc(per.wallet);
    if (user == currentDoc) {
      phi.push(per);
      console.log(phi);
      await phiToBlockchain(per);
      res.send("Personal Health Data is added to the database");
    } else {
      res.send("Permission denied, you are not the responsible clinician");
    }
  }
});

//check responsible clinician from blockchain

async function checkDoc(per) {
  const currentValue = await storage.getPatient(per);
  console.log(`Logged in user is: ${user}`);
  console.log(`Current responsible clinician is: ${currentValue[1]}`);
  return currentValue[1].toLowerCase();
}

async function phiToBlockchain(per) {
  const currentValue = await storage.addPhi(
    per.ssn,
    per.wallet,
    per.responsibleClinician,
    per.meta
  );
  await currentValue.wait(1);
}

app.get("/viewpatientshealthdata", (req, res) => {
  res.json(phi);
});

let prescriptions = [
  {
    ssn: "2001",
    id: "901",
    name: "Ammar Hassan",
    Disease: "fever",
    prescription: "panador",
    Clinician: "0x7d131118eb2486B6F178Ee4A4496273CcfF54f48",
    meta: "f8dc65b17a09bf303105ef9a5e2b2cc2b12d6fc2",
  },
  {
    ssn: "2002",
    id: "902",
    name: "Saad Faisal",
    Disease: "stomach upset",
    prescription: "flagyl",
    Clinician: "0xEdD16B9c7ccf81b2D17076c77732f7030865db0B",
    meta: "d680fb1067e9cd57f0ee9ae9c999e7658a02e0fd",
  },
];
app.post("/addprescriptions", async function (req, res) {
  const per = req.body;
  const meta = sha1(JSON.stringify(per));
  console.log(meta);
  per.meta = meta;
  console.log(per);
  prescriptions.push(per);
  console.log(prescriptions);
  await subToBlockchain(per);
  res.send("prescription added to the database");
});

async function subToBlockchain(per) {
  const currentValue = await storage.addSub(per.id, per.Clinician, per.meta);
  await currentValue.wait(1);
}

app.get("/viewprescriptions", (req, res) => {
  res.json(prescriptions);
});

app.get("/viewpatientshealthdata/:ssn", async function (req, res) {
  // Reading ssn from the URL
  const ssn = req.params.ssn;
  //search for patient wallet address
  let tempAddress;
  for (let ph of phi) {
    if (ph.ssn === ssn) {
      tempAddress = ph.wallet.toLowerCase();
    }
  }
  console.log(`current patients address is ${tempAddress}`);
  let currentDoc = await checkDoc(tempAddress);
  console.log(`patients responsible clinician is ${currentDoc}`);
  let currentAcl = await getphiaclex(tempAddress);
  console.log(`current ACL is true or false ${currentAcl}`);
  if (user == tempAddress || user == currentDoc || currentAcl) {
    // Searching phi for the patient
    for (let ph of phi) {
      if (ph.ssn === ssn) {
        res.json(ph);
        return;
      }
    }
    // console.log("chcek");
    // Sending 404 when not found something is a good practice
    res.status(404).send("Not Found");
  } else {
    res.status(401).send("Not Authorized to view data");
  }
});

app.get("/viewprescriptions/:id", async function (req, res) {
  // Reading id from the URL
  const id = req.params.id;
  let tempSSN;
  let tempAddress;
  let tempDoctor;
  let currentDoc = await checkTdoc(id);
  for (let ph of prescriptions) {
    if (ph.id === id) {
      tempSSN = ph.ssn;
      for (let ph of phi) {
        if (ph.ssn === tempSSN) {
          tempAddress = ph.wallet.toLowerCase();
          tempDoctor = ph.Clinician;
        }
      }
      console.log(`current patients SSN is ${tempSSN}`);
      console.log(`current patients address is ${tempAddress}`);
      currentDoc = await checkDoc(tempAddress);
      console.log(`patients responsible clinician is ${currentDoc}`);
      console.log(`Medicine prescribed by ${currentDoc}`);
    }
  }
  let currentAcl = await getsubaclex(id);
  console.log(`current ACL is true or false ${currentAcl}`);
  if (
    user == tempAddress ||
    user == currentDoc ||
    user == tempDoctor ||
    currentAcl
  ) {
    // Searching presecription
    for (let ph of prescriptions) {
      if (ph.id === id) {
        res.json(ph);
        return;
      }
    }

    // Sending 404 when not found something is a good practice
    res.status(404).send("Patient not found");
  } else {
    res.status(401).send("Not Authorized to view data");
  }
});

async function checkTdoc(id) {
  const currentValue = await storage.getSub(id);
  console.log(`Prescription ID is: ${id}`);
  console.log(`Medicine precribed by clinician : ${currentValue[0]}`);
  return currentValue[0].toLowerCase();
}

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
  console.log(user);
  let success = "Logged in successfully";
  let failure = "Failed to verify signature";
  if (uwallet == calcAddress) {
    res.send(success);
  } else {
    res.send(failure);
  }
});

// ACLs
//ACL for PHI
app.post("/addphiacl", async function (req, res) {
  const per = req.body;
  let currentDoc = await checkDoc(per.patient);
  if (user == currentDoc) {
    console.log("adding to blockchain");
    await phiaclToBlockchain(per);
    res.send("Doctor is added to the ACL");
  } else {
    console.log("doctor is not responsible clinician");
    res.send("You are not the responsible clincian");
  }
});

async function phiaclToBlockchain(per) {
  const currentValue = await storage.addPhiacl(per.patient, per.doc);
  console.log(per.doc);
  await currentValue.wait(1);
}

//prescription ACLs
app.post("/addpresacl", async function (req, res) {
  const per = req.body;

  await presaclToBlockchain(per);
  res.send("Doctor is added to the ACL");
});

async function presaclToBlockchain(per) {
  const currentValue = await storage.addSubacl(per.id, per.Clinician);
  console.log(per.Clinician);
  await currentValue.wait(1);
}

//checking ACLs they work
// let aclCheck = false;
// getphiaclex();
async function getphiaclex(_wallet) {
  const currentValue = await storage.getPhiacl(_wallet);
  console.log(`ph1 acl1: ${currentValue}`);
  console.log(typeof currentValue);
  for (let i of currentValue) {
    console.log(`user is =${user}`);
    console.log(`current value is =${i}`);
    if (user.toLowerCase() == i.toLowerCase()) {
      return true;
    }
    console.log("Not Matched");
    return false;
  }
}
//   const phiValue = await storage.getPhiacl(
//     "0xEdD16B9c7ccf81b2D17076c77732f7030865db0B"
//   );
//   console.log(`ph1 acl2: ${phiValue}`);
// }

async function getsubaclex(_id) {
  const currentValue = await storage.getSubacl(_id);
  console.log(`prescription acl1: ${currentValue}`);
  console.log(typeof currentValue);
  for (let i of currentValue) {
    console.log(`user is =${user}`);
    console.log(`current value is =${i}`);
    if (user.toLowerCase() == i.toLowerCase()) {
      return true;
    }
    console.log("Not Matched");
    return false;
  }
}
// getting data from cloud
// axios
//   .get("https://iui7uypps9.execute-api.us-west-2.amazonaws.com/items")
//   .then((res) => {
//     const headerDate =
//       res.headers && res.headers.date ? res.headers.date : "no response date";
//     console.log("Status Code:", res.status);
//     console.log("Date in Response header:", headerDate);

//     const receivedData = res.data;
//     console.log(receivedData.Items);
//     for (user of receivedData.Items) {
//       console.log(`Got user with id: ${user.id}, hash: ${user.hash}`);
//     }
//   })
//   .catch((err) => {
//     console.log("Error: ", err.message);
//   });

// let y = 121;
// cloudVerify(y);
async function cloudVerify(y, x) {
  const url = `https://iui7uypps9.execute-api.us-west-2.amazonaws.com/items/${y}`;
  console.log(url);
  let xy = 0;
  await axios
    .get(url)
    .then((res) => {
      const headerDate =
        res.headers && res.headers.date ? res.headers.date : "no response date";
      console.log("Status Code:", res.status);
      console.log("Date in Response header:", headerDate);

      const receivedData = res.data;
      const receivedItem = receivedData.Item;
      // console.log(receivedItem);
      console.log(
        `Got user with id: ${receivedItem.id}, hash: ${receivedItem.hash}`
      );
      console.log(`received item hash is ${receivedItem.hash}`);
      console.log(`meta is : ${x}, hash: ${receivedItem.hash}`);
      xy = 1;
      return xy;
    })
    .catch((err) => {
      console.log("Error: ", err.message);
    });
  return xy;
}
app.listen(port, () => console.log(`Doctors API listening on ${port}!`));
