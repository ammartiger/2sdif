// I'm a comment!
// SPDX-License-Identifier: MIT

pragma solidity 0.8.17;


contract SimpleStorage {
   
struct adminInfo {
    string ssn;
    address account;
    string meta;
}


//...................................Admins..........................................//
   //create an array of admins  
    adminInfo[] internal admins;

 //Mapping to search for admins with address return the struct 
    
        mapping(address => adminInfo) public adminaddressTossn;


//admin store function
  
    function addAdmin(string memory _ssn, address _adminAddress, string memory _meta) public {
        adminInfo memory newAdmin;
        newAdmin.ssn=_ssn;
        newAdmin.account=_adminAddress;
        newAdmin.meta=_meta;
        admins.push(newAdmin);
        adminaddressTossn[_adminAddress] = newAdmin;
     }

     //admin verify/view function
     function getAdmin(address _adminAddress) public view returns (string memory, string memory){
        adminInfo memory s = adminaddressTossn[_adminAddress];
        return (s.ssn,s.meta);
    }
    //...................................patients..........................................//

struct patientInfo {
    string ssn;
    address account;
    address doctor;
    string meta;
}



   //create an array of admins  
    patientInfo[] internal patients;

 //Mapping to search for patient with address return the struct 
    
        mapping(address => patientInfo) public patientaddressTossn;


//patient store function
  
    function addPatient(string memory _ssn, address _patientAddress, address _doctorAddress, string memory _meta) public {
        patientInfo memory newPatient;
        newPatient.ssn=_ssn;
        newPatient.account=_patientAddress;
        newPatient.doctor=_doctorAddress;
        newPatient.meta=_meta;

        patients.push(newPatient);
        patientaddressTossn[_patientAddress] = newPatient;
     }

     //patient verify/view function
     function getPatient(address _patientAddress) public view returns (string memory, address, string memory){
        patientInfo memory s = patientaddressTossn[_patientAddress];
        return (s.ssn, s.doctor, s.meta);
    }


//...................................Doctors..........................................//

struct doctorsInfo {
    string ssn;
    address account;
    string meta;
}


   //create an array of doctors  
    doctorsInfo[] internal doctors;

 //Mapping to search for doctors with address return the struct 
    
        mapping(address => doctorsInfo) public doctoraddressTossn;


//doctor store function
  
    function addDoctor(string memory _ssn, address _doctorAddress, string memory _meta) public {
        doctorsInfo memory newDoctor;
        newDoctor.ssn=_ssn;
        newDoctor.account=_doctorAddress;
        newDoctor.meta=_meta;
        doctors.push(newDoctor);
        doctoraddressTossn[_doctorAddress] = newDoctor;
     }

     //doctor verify/view function
     function getDoctor(address _doctorAddress) public view returns (string memory, string memory){
        doctorsInfo memory s = doctoraddressTossn[_doctorAddress];
        return (s.ssn,s.meta);
    }

    //...................................PHI..........................................//
address[] allowedDoctors;
struct phiInfo {
    string ssn;
    address wallet;
    address account;
    string meta;
    address[] allowedDoctors;
}


   //create an array of phi 
    phiInfo[] internal phis;

 //Mapping to search for phi with address return the struct 
    
        mapping(address => phiInfo) public phiaddressTossn;


//phi store function
  
    function addPhi(string memory _ssn, address _wallet, address _phiAddress, string memory _meta) public {

        phiInfo memory newPhi;
        newPhi.ssn=_ssn;
        newPhi.wallet=_wallet;
        newPhi.account=_phiAddress;
        newPhi.meta=_meta;
        phis.push(newPhi);
        phiaddressTossn[_wallet] = newPhi;
     }

     //PHI verify/view function
     function getPhi(address _phiAddress) public view returns (string memory, string memory, address account){
        phiInfo memory s = phiaddressTossn[_phiAddress];
        return (s.ssn,s.meta,s.account);
    }
    //get PHI acl
     function getPhiacl(address _phiAddress) public view returns (address[] memory){
        phiInfo memory s = phiaddressTossn[_phiAddress];
        return (s.allowedDoctors);
    }
     //PHI add to acl
     function addPhiacl(address _phiAddress, address _docAddress) public {
        phiInfo storage s = phiaddressTossn[_phiAddress];
        s.allowedDoctors.push(_docAddress);
    }

       //...................................Prescriptions..........................................//
address[] allowed;
struct subInfo {
    string id;
    address account;
    string meta;
    address[] allowed;
}


   //create an array of phi 
    subInfo[] internal subs;

 //Mapping to search for subs with id return the struct 
    
        mapping(string => subInfo) public idToAddress;


//prescription store function
  
    function addSub(string memory _id, address _subAddress, string memory _meta) public {
        subInfo memory newSub;
        newSub.id=_id;
        newSub.account=_subAddress;
        newSub.meta=_meta;
        subs.push(newSub);
        idToAddress[_id] = newSub;
     }

     //prescription verify/view function
     function getSub(string memory _id) public view returns (address , string memory){
        subInfo memory s = idToAddress[_id];
        return (s.account,s.meta);
    }
  //get Prescription acl
     function getSubacl(string memory _id) public view returns (address[] memory){
        subInfo memory s = idToAddress[_id];
        return (s.allowed);
    }
     //prescription add to acl
     function addSubacl(string memory _id, address _docAddress) public {
        subInfo storage s = idToAddress[_id];
        s.allowed.push(_docAddress);
    }

}

