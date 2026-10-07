async function sendToCloud() {
  console.log("Function send to cloud");

  const ssn = document.getElementById("ssnid").value;
  const wallet = document.getElementById("walletid").value;
  const name = document.getElementById("nameid").value;
  const disease = document.getElementById("diseaseid").value;
  const health = document.getElementById("healthid").value;
  const doc = document.getElementById("docid").value;
  const payment = document.getElementById("paymentid").value;
  const formDataObj = {};
  formDataObj.ssn = ssn;
  formDataObj.wallet = wallet;
  formDataObj.name = name;
  formDataObj.Diseases = disease;
  formDataObj.healthPlan = health;
  formDataObj.responsibleClinician = doc;
  formDataObj.payment = payment;

  console.log(formDataObj);
  let hash = await sha1(JSON.stringify(formDataObj));
  console.log(hash);
  send(ssn, hash);
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

///aws check functions
async function send(id, hash) {
  var xhr = new XMLHttpRequest();
  xhr.open(
    "PUT",
    "https://iui7uypps9.execute-api.us-west-2.amazonaws.com/items",
    true
  );
  xhr.setRequestHeader("Content-Type", "application/json");
  // let hello = "id";
  // let sign = "price";
  // let wallet = "name";
  await xhr.send(
    JSON.stringify({
      id: id,
      hash: hash,
    })
  );
  response = xhr.res;
  console.log(response);
}
