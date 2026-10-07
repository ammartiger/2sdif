function web3_check_metamask() {
  if (!window.ethereum) {
    console.error(
      "It seems that the MetaMask extension is not detected. Please install MetaMask first."
    );
    alert(
      "It seems that the MetaMask extension is not detected. Please install MetaMask first."
    );
    return false;
  } else {
    console.log("MetaMask extension has been detected!!");
    return true;
  }
}
async function getNounce() {
  const xhttp = new XMLHttpRequest();

  xhttp.open("GET", "http://localhost:3000/getnounce", false);
  xhttp.send();

  hashed_string = JSON.parse(xhttp.responseText);
  console.log(hashed_string);
  return hashed_string;
}
async function web3_metamask_login() {
  // Check first if the user has the MetaMask installed
  if (web3_check_metamask()) {
    console.log("Initate Login Process");

    // Get the Ethereum provider
    const provider = new ethers.providers.Web3Provider(window.ethereum);
    // Get Ethereum accounts
    await provider.send("eth_requestAccounts", []);
    console.log("Connected!!");
    // Get the User Ethereum address
    const address = await provider.getSigner().getAddress();
    console.log(address);

    // Create hashed string

    const hashed_string = await getNounce();
    console.log("Hashed string: " + hashed_string);
    // Request the user to sign it
    const signature = await provider.getSigner().signMessage(hashed_string);
    // Got the signature
    console.log("The signature: " + signature);

    // TODO
    // you can then send the signature to the webserver for further processing and verification

    var xhr = new XMLHttpRequest();
    xhr.open("POST", "http://localhost:3000/loginadmin", true);
    xhr.setRequestHeader("Content-Type", "application/json");
    // let hello = "string";
    // let sign = "signature";
    // let wallet = "wallet";
    await xhr.send(
      JSON.stringify({
        hello: hashed_string,
        wallet: address,
        sign: signature,
      })
    );
    response = xhr.res;
    console.log(response);
  }
  let x = document.getElementById("user");
  x.innerHTML = "Logged in";
  x.disabled = true;
}
