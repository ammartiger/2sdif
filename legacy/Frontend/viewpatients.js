// import sha1 from "sha1";
let patients;
const loadPatients = async () => {
  const xhttp = new XMLHttpRequest();

  xhttp.open("GET", "http://localhost:3000/patients", false);
  xhttp.send();

  patients = JSON.parse(xhttp.responseText);
  // console.log(patients);
  for (let patient of patients) {
    //copy object meta info
    let tempMeta = patient.meta;
    // console.log(tempMeta);
    //remove meta hash value calculate hash
    delete patient.meta;
    // console.log(patient);

    let hash = await sha1(JSON.stringify(patient));
    // console.log(hash);

    //append meta and recalculated hash
    patient.meta = tempMeta;
    patient.calmeta = hash;
    console.log(patient);
    console.log(patients);
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
loadPatients();
loadadmin();

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
  tableFromJson(patients);
}

function tableForAdmin() {
  tableFromJson(admins);
}
