// import sha1 from "sha1";
let doctors;
let tWallet;
let tHash;
const loadDoctors = async () => {
  const xhttp = new XMLHttpRequest();

  xhttp.open("GET", "http://localhost:3001/doctors", false);
  xhttp.send();

  doctors = JSON.parse(xhttp.responseText);
  // console.log(patients);
  for (let doctor of doctors) {
    //copy object meta info
    let tempMeta = doctor.meta;
    // console.log(tempMeta);
    //remove meta hash value calculate hash
    delete doctor.meta;
    // console.log(patient);

    let hash = await sha1(JSON.stringify(doctor));
    // console.log(hash);

    //append meta and recalculated hash
    doctor.meta = tempMeta;
    doctor.calmeta = hash;
    console.log(doctor);
    console.log(doctors);
    //display on screen
  }
};

let admins;
const loadadmin = async () => {
  const xhttp = new XMLHttpRequest();

  xhttp.open("GET", "http://localhost:3000/admin", false);
  xhttp.send();

  admins = JSON.parse(xhttp.responseText);
  // console.log(patients);
  for (let admin of admins) {
    //copy object meta info
    let tempMeta = admin.meta;
    // console.log(tempMeta);
    //remove meta hash value calculate hash
    delete admin.meta;
    // console.log(patient);

    let hash = await sha1(JSON.stringify(admin));
    // console.log(hash);

    //append meta and recalculated hash
    admin.meta = tempMeta;
    admin.calmeta = hash;
    console.log(admin);

    //display on screen
  }
};

let phis;
const loadphi = async () => {
  const xhttp = new XMLHttpRequest();

  xhttp.open("GET", "http://localhost:3001/viewpatientshealthdata", false);
  xhttp.send();

  phis = JSON.parse(xhttp.responseText);
  // console.log(patients);
  for (let phi of phis) {
    //copy object meta info
    let tempMeta = phi.meta;
    // console.log(tempMeta);
    //remove meta hash value calculate hash
    delete phi.meta;
    // console.log(patient);

    let hash = await sha1(JSON.stringify(phi));
    // console.log(hash);

    //append meta and recalculated hash
    phi.meta = tempMeta;
    phi.calmeta = hash;
    console.log(phi);

    //display on screen
  }
};

let prescriptions;
const loadprescriptions = async () => {
  const xhttp = new XMLHttpRequest();

  xhttp.open("GET", "http://localhost:3001/viewprescriptions", false);
  xhttp.send();

  prescriptions = JSON.parse(xhttp.responseText);
  // console.log(patients);
  for (let prescription of prescriptions) {
    //copy object meta info
    let tempMeta = prescription.meta;
    // console.log(tempMeta);
    //remove meta hash value calculate hash
    delete prescription.meta;
    // console.log(patient);

    let hash = await sha1(JSON.stringify(prescription));
    // console.log(hash);

    //append meta and recalculated hash
    prescription.meta = tempMeta;
    prescription.calmeta = hash;
    console.log(prescription);

    //display on screen
  }
};

loadDoctors();
loadadmin();
loadphi();
loadprescriptions();

async function sha1(message) {
  const msgUint8 = new TextEncoder().encode(message); // encode as (utf-8) Uint8Array
  const hashBuffer = await crypto.subtle.digest("SHA-1", msgUint8); // hash the message
  const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(""); // convert bytes to hex string
  return hashHex;
}

let tableFromJson = (Jobject) => {
  // the json data.

  // Extract value from table header.
  // ('Book ID', 'Book Name', 'Category' and 'Price')
  let col = [];
  for (let i = 0; i < Jobject.length; i++) {
    for (let key in Jobject[i]) {
      if (col.indexOf(key) === -1) {
        col.push(key);
      }
    }
  }

  // Create table.
  const table = document.createElement("table");

  // Create table header row using the extracted headers above.
  let tr = table.insertRow(-1); // table row.

  for (let i = 0; i < col.length; i++) {
    let th = document.createElement("th"); // table header.
    th.innerHTML = col[i];
    tr.appendChild(th);
  }

  // add json data to the table as rows.
  for (let i = 0; i < Jobject.length; i++) {
    tr = table.insertRow(-1);

    for (let j = 0; j < col.length; j++) {
      let tabCell = tr.insertCell(-1);
      tabCell.innerHTML = Jobject[i][col[j]];
    }
  }

  // Now, add the newly created table with json data, to a container.
  const divShowData = document.getElementById("showData");
  divShowData.innerHTML = "";
  divShowData.appendChild(table);
};

function tableFrom() {
  tableFromJson(doctors);
}

function tableForAdmin() {
  tableFromJson(admins);
}

function tableForPhi() {
  tableFromJson(phis);
}

function tableForPrescriptions() {
  tableFromJson(prescriptions);
}

//searching for patients health data with SSN
let ssn;
let ssnArray = [];
async function searchSsn() {
  let tempssn = document.getElementById("ssn");
  let ssnvalue = tempssn.value;
  const xhttp = new XMLHttpRequest();

  xhttp.open(
    "GET",
    `http://localhost:3001/viewpatientshealthdata/${ssnvalue}`,
    false
  );
  xhttp.send();
  try {
    ssn = JSON.parse(xhttp.responseText);

    console.log(ssn);

    let tempMeta = ssn.meta;
    // console.log(tempMeta);
    //remove meta hash value calculate hash
    delete ssn.meta;

    // console.log(patient);
    tWallet = ssn.wallet;
    console.log(`twallet= ${tWallet}`);
    let hash = await sha1(JSON.stringify(ssn));
    // console.log(hash);

    //append meta and recalculated hash
    ssn.meta = tempMeta;
    tHash = ssn.meta;
    ssn.calmeta = hash;
    console.log(ssn);
    ssnArray.push(ssn);
    tableFromJson(ssnArray);

    //display on screen
  } catch {
    alert("Patient not found");
  }
  document.getElementById("Verify").style.display = "block";
}

//searching for patients subscriptions with ID
let fprescriptions;
let fprescriptionsArray = [];
async function searchPrescriptions() {
  let fprescriptions = document.getElementById("fprescriptions");
  let fprescriptionsvalue = fprescriptions.value;
  tID = fprescriptionsvalue;
  const xhttp = new XMLHttpRequest();

  xhttp.open(
    "GET",
    `http://localhost:3001/viewprescriptions/${fprescriptionsvalue}`,
    false
  );
  xhttp.send();
  try {
    fprescriptions = JSON.parse(xhttp.responseText);

    console.log(fprescriptions);

    let tempMeta = fprescriptions.meta;
    // console.log(tempMeta);
    //remove meta hash value calculate hash
    delete fprescriptions.meta;
    // console.log(patient);

    let hash = await sha1(JSON.stringify(fprescriptions));
    // console.log(hash);

    //append meta and recalculated hash
    fprescriptions.meta = tempMeta;
    tHash = tempMeta;
    fprescriptions.calmeta = hash;
    console.log(fprescriptions);
    fprescriptionsArray.push(fprescriptions);
    tableFromJson(fprescriptionsArray);

    //display on screen
  } catch {
    alert("Patient not found");
  }
  document.getElementById("VerifyP").style.display = "block";
}

async function verify() {
  await connect();
  await getBMeta();
  console.log(`hash is ${tHash}`);
  console.log(`Blockchain hash is ${Bmeta}`);
  if (tHash == Bmeta) {
    document.getElementById("Verify").innerHTML = "Verified";
  } else {
    document.getElementById("Verify").innerHTML = " Not Verified";
  }
  console.log(`Meta from Blockchain is ${Bmeta}`);
  document.getElementById(
    "verifyData"
  ).innerHTML = `Hash from Blockchain is ${Bmeta} `;
}
//verification from blockchain
async function connect() {
  if (typeof window.ethereum !== "undefined") {
    try {
      await ethereum.request({ method: "eth_requestAccounts" });
    } catch (error) {
      console.log(error);
    }
    // connectButton.innerHTML = "Connected";
    const accounts = await ethereum.request({ method: "eth_accounts" });
    console.log(accounts);
  } else {
    alert("Please install MetaMask");
  }
}

//verify from blockchain
let Bmeta;
async function getBMeta() {
  if (typeof window.ethereum !== "undefined") {
    const provider = new ethers.providers.Web3Provider(window.ethereum);
    const signer = provider.getSigner();
    const contract = new ethers.Contract(contractAddress, abi, signer);
    const transactionResponse = await contract.getPhi(tWallet);
    console.log(transactionResponse);
    Bmeta = transactionResponse[1];
  } else {
    alert("metamask not found");
  }
}

//verify prescriptions
async function verifyP() {
  await connect();
  console.log("in p verify");
  await getPMeta();
  console.log(`hash is ${tHash}`);
  console.log(`Blockchain hash is ${Pmeta}`);
  if (tHash == Pmeta) {
    document.getElementById("VerifyP").innerHTML = "Verified";
  } else {
    document.getElementById("VerifyP").innerHTML = " Not Verified";
  }
  console.log(`Meta from Blockchain is ${Pmeta}`);
  document.getElementById(
    "verifyData"
  ).innerHTML = `Hash from Blockchain is ${Pmeta} `;
}

//verify from blockchain
let tID;
let Pmeta;
async function getPMeta() {
  if (typeof window.ethereum !== "undefined") {
    const provider = new ethers.providers.Web3Provider(window.ethereum);
    const signer = provider.getSigner();
    const contract = new ethers.Contract(contractAddress, abi, signer);
    const transactionResponse = await contract.getSub(tID);
    console.log(transactionResponse);
    Pmeta = transactionResponse[1];
  } else {
    alert("metamask not found");
  }
}
const contractAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const abi = [
  {
    inputs: [
      {
        internalType: "string",
        name: "_ssn",
        type: "string",
      },
      {
        internalType: "address",
        name: "_adminAddress",
        type: "address",
      },
      {
        internalType: "string",
        name: "_meta",
        type: "string",
      },
    ],
    name: "addAdmin",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "string",
        name: "_ssn",
        type: "string",
      },
      {
        internalType: "address",
        name: "_doctorAddress",
        type: "address",
      },
      {
        internalType: "string",
        name: "_meta",
        type: "string",
      },
    ],
    name: "addDoctor",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "string",
        name: "_ssn",
        type: "string",
      },
      {
        internalType: "address",
        name: "_patientAddress",
        type: "address",
      },
      {
        internalType: "address",
        name: "_doctorAddress",
        type: "address",
      },
      {
        internalType: "string",
        name: "_meta",
        type: "string",
      },
    ],
    name: "addPatient",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "string",
        name: "_ssn",
        type: "string",
      },
      {
        internalType: "address",
        name: "_wallet",
        type: "address",
      },
      {
        internalType: "address",
        name: "_phiAddress",
        type: "address",
      },
      {
        internalType: "string",
        name: "_meta",
        type: "string",
      },
    ],
    name: "addPhi",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "_phiAddress",
        type: "address",
      },
      {
        internalType: "address",
        name: "_docAddress",
        type: "address",
      },
    ],
    name: "addPhiacl",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "string",
        name: "_id",
        type: "string",
      },
      {
        internalType: "address",
        name: "_subAddress",
        type: "address",
      },
      {
        internalType: "string",
        name: "_meta",
        type: "string",
      },
    ],
    name: "addSub",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "string",
        name: "_id",
        type: "string",
      },
      {
        internalType: "address",
        name: "_docAddress",
        type: "address",
      },
    ],
    name: "addSubacl",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "",
        type: "address",
      },
    ],
    name: "adminaddressTossn",
    outputs: [
      {
        internalType: "string",
        name: "ssn",
        type: "string",
      },
      {
        internalType: "address",
        name: "account",
        type: "address",
      },
      {
        internalType: "string",
        name: "meta",
        type: "string",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "",
        type: "address",
      },
    ],
    name: "doctoraddressTossn",
    outputs: [
      {
        internalType: "string",
        name: "ssn",
        type: "string",
      },
      {
        internalType: "address",
        name: "account",
        type: "address",
      },
      {
        internalType: "string",
        name: "meta",
        type: "string",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "_adminAddress",
        type: "address",
      },
    ],
    name: "getAdmin",
    outputs: [
      {
        internalType: "string",
        name: "",
        type: "string",
      },
      {
        internalType: "string",
        name: "",
        type: "string",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "_doctorAddress",
        type: "address",
      },
    ],
    name: "getDoctor",
    outputs: [
      {
        internalType: "string",
        name: "",
        type: "string",
      },
      {
        internalType: "string",
        name: "",
        type: "string",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "_patientAddress",
        type: "address",
      },
    ],
    name: "getPatient",
    outputs: [
      {
        internalType: "string",
        name: "",
        type: "string",
      },
      {
        internalType: "address",
        name: "",
        type: "address",
      },
      {
        internalType: "string",
        name: "",
        type: "string",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "_phiAddress",
        type: "address",
      },
    ],
    name: "getPhi",
    outputs: [
      {
        internalType: "string",
        name: "",
        type: "string",
      },
      {
        internalType: "string",
        name: "",
        type: "string",
      },
      {
        internalType: "address",
        name: "account",
        type: "address",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "_phiAddress",
        type: "address",
      },
    ],
    name: "getPhiacl",
    outputs: [
      {
        internalType: "address[]",
        name: "",
        type: "address[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "string",
        name: "_id",
        type: "string",
      },
    ],
    name: "getSub",
    outputs: [
      {
        internalType: "address",
        name: "",
        type: "address",
      },
      {
        internalType: "string",
        name: "",
        type: "string",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "string",
        name: "_id",
        type: "string",
      },
    ],
    name: "getSubacl",
    outputs: [
      {
        internalType: "address[]",
        name: "",
        type: "address[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "string",
        name: "",
        type: "string",
      },
    ],
    name: "idToAddress",
    outputs: [
      {
        internalType: "string",
        name: "id",
        type: "string",
      },
      {
        internalType: "address",
        name: "account",
        type: "address",
      },
      {
        internalType: "string",
        name: "meta",
        type: "string",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "",
        type: "address",
      },
    ],
    name: "patientaddressTossn",
    outputs: [
      {
        internalType: "string",
        name: "ssn",
        type: "string",
      },
      {
        internalType: "address",
        name: "account",
        type: "address",
      },
      {
        internalType: "address",
        name: "doctor",
        type: "address",
      },
      {
        internalType: "string",
        name: "meta",
        type: "string",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "",
        type: "address",
      },
    ],
    name: "phiaddressTossn",
    outputs: [
      {
        internalType: "string",
        name: "ssn",
        type: "string",
      },
      {
        internalType: "address",
        name: "wallet",
        type: "address",
      },
      {
        internalType: "address",
        name: "account",
        type: "address",
      },
      {
        internalType: "string",
        name: "meta",
        type: "string",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
];
