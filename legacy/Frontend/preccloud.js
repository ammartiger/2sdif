async function sendToCloud() {
  console.log("Function send to cloud");

  const ssn = document.getElementById("ssnid").value;
  const pressid = document.getElementById("presid").value;
  const name = document.getElementById("nameid").value;
  const disese = document.getElementById("diseseid").value;
  const full = document.getElementById("fullid").value;
  const doc = document.getElementById("docid").value;

  const formDataObj = {};
  formDataObj.ssn = ssn;
  formDataObj.id = pressid;
  formDataObj.name = name;
  formDataObj.Disease = disese;
  formDataObj.prescription = full;
  formDataObj.Clinician = doc;
  console.log(formDataObj);
  let hash = await sha1(JSON.stringify(formDataObj));
  console.log(hash);
}
async function sha1(message) {
  const msgUint8 = new TextEncoder().encode(message); // encode as (utf-8) Uint8Array
  const hashBuffer = await crypto.subtle.digest("SHA-1", msgUint8); // hash the message
  const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(""); // convert bytes to hex string
  return hashHex;
}
