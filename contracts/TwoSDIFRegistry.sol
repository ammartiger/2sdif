// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title 2SDIF registry: witness-verified integrity proofs and contract-enforced access control
/// @notice Device records are accepted only with an attestation signed by the registered witness.
///         The gateway that submits them is untrusted: it cannot change the digest or forge the attestation.
///         User records and ACL changes are signed by the users themselves (msg.sender is checked).
contract TwoSDIFRegistry {
    string public constant DOMAIN_TAG = "2SDIF-v1";

    address public admin;
    address public witness;

    // ------------------------------------------------------------------
    // Device proofs (dual channel path)
    // ------------------------------------------------------------------
    struct Proof {
        bytes32 digest;     // SHA-256 of the canonical record, as deposited by the device
        bytes32 deviceId;   // device identifier attested by the witness
        uint64 witnessTime; // witness timestamp (seconds)
    }
    mapping(bytes32 => Proof) private _proofs; // record id => proof

    // ------------------------------------------------------------------
    // Participants
    // ------------------------------------------------------------------
    struct Patient {
        address account;
        address responsibleClinician;
        bytes32 metaDigest; // digest of the off-chain personal record
        bool exists;
    }
    mapping(bytes32 => Patient) public patients;       // pseudonymous patient id => patient
    mapping(address => bool) public isClinician;
    mapping(address => bytes32) public clinicianMeta;  // digest of the off-chain clinician record
    mapping(address => bool) public isMedicalStore;

    // ------------------------------------------------------------------
    // User records (health information, prescriptions) and ACLs
    // ------------------------------------------------------------------
    struct UserRecord {
        bytes32 digest;
        bytes32 pid;
        address author;
        uint64 time;
    }
    mapping(bytes32 => UserRecord) public phiRecords;                 // record id => PHI record
    mapping(bytes32 => mapping(address => bool)) private _phiAcl;     // pid => reader => allowed
    mapping(bytes32 => UserRecord) public prescriptions;              // prescription id => record
    mapping(bytes32 => mapping(address => bool)) private _rxAcl;      // prescription id => reader => allowed

    // ------------------------------------------------------------------
    // Events and errors
    // ------------------------------------------------------------------
    event ProofCommitted(bytes32 indexed rid, bytes32 digest, bytes32 indexed deviceId, uint64 witnessTime, address submitter);
    event WitnessChanged(address indexed previous, address indexed current);
    event ClinicianRegistered(address indexed clinician, bool active);
    event MedicalStoreRegistered(address indexed store, bool active);
    event PatientRegistered(bytes32 indexed pid, address account, address responsibleClinician);
    event ClinicianReassigned(bytes32 indexed pid, address previous, address current);
    event PhiRecordAdded(bytes32 indexed rid, bytes32 indexed pid, bytes32 digest, address author);
    event PrescriptionAdded(bytes32 indexed rxId, bytes32 indexed pid, bytes32 digest, address prescriber);
    event PhiAccessChanged(bytes32 indexed pid, address indexed reader, bool allowed, address by);
    event RxAccessChanged(bytes32 indexed rxId, address indexed reader, bool allowed, address by);

    error NotAdmin();
    error NotClinician();
    error NotResponsibleClinician();
    error NotPrescriberOrResponsible();
    error UnknownPatient();
    error UnknownPrescription();
    error AlreadyExists();
    error AlreadyCommitted(bytes32 rid);
    error EmptyDigest();
    error InvalidAttestation();
    error ZeroAddress();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyClinician() {
        if (!isClinician[msg.sender]) revert NotClinician();
        _;
    }

    modifier onlyResponsible(bytes32 pid) {
        Patient storage p = patients[pid];
        if (!p.exists) revert UnknownPatient();
        if (msg.sender != p.responsibleClinician) revert NotResponsibleClinician();
        _;
    }

    constructor(address witness_) {
        if (witness_ == address(0)) revert ZeroAddress();
        admin = msg.sender;
        witness = witness_;
        emit WitnessChanged(address(0), witness_);
    }

    // ==================================================================
    // Witness management
    // ==================================================================
    function setWitness(address newWitness) external onlyAdmin {
        if (newWitness == address(0)) revert ZeroAddress();
        emit WitnessChanged(witness, newWitness);
        witness = newWitness;
    }

    // ==================================================================
    // Dual channel path: attested device proofs
    // ==================================================================

    /// @notice The message the witness signs (EIP-191 personal_sign over this 32-byte value).
    ///         Chain id and contract address are bound in to prevent cross-deployment replay.
    function attestationMessage(bytes32 rid, bytes32 digest, bytes32 deviceId, uint64 witnessTime)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(DOMAIN_TAG, block.chainid, address(this), rid, digest, deviceId, witnessTime));
    }

    /// @notice Commit a device proof. Anyone may submit (normally the fog gateway), but only a digest
    ///         attested by the registered witness is accepted, and only once per record id.
    function commitProof(bytes32 rid, bytes32 digest, bytes32 deviceId, uint64 witnessTime, bytes calldata signature)
        external
    {
        if (digest == bytes32(0)) revert EmptyDigest();
        if (_proofs[rid].digest != bytes32(0)) revert AlreadyCommitted(rid);
        bytes32 ethSigned = MessageHashUtils.toEthSignedMessageHash(
            attestationMessage(rid, digest, deviceId, witnessTime)
        );
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(ethSigned, signature);
        if (err != ECDSA.RecoverError.NoError || signer != witness) revert InvalidAttestation();
        _proofs[rid] = Proof(digest, deviceId, witnessTime);
        emit ProofCommitted(rid, digest, deviceId, witnessTime, msg.sender);
    }

    function getProof(bytes32 rid) external view returns (bytes32 digest, bytes32 deviceId, uint64 witnessTime) {
        Proof storage p = _proofs[rid];
        return (p.digest, p.deviceId, p.witnessTime);
    }

    // ==================================================================
    // Registration (administrator only)
    // ==================================================================
    function registerClinician(address clinician, bytes32 metaDigest) external onlyAdmin {
        if (clinician == address(0)) revert ZeroAddress();
        isClinician[clinician] = true;
        clinicianMeta[clinician] = metaDigest;
        emit ClinicianRegistered(clinician, true);
    }

    function deactivateClinician(address clinician) external onlyAdmin {
        isClinician[clinician] = false;
        emit ClinicianRegistered(clinician, false);
    }

    function registerMedicalStore(address store, bool active) external onlyAdmin {
        if (store == address(0)) revert ZeroAddress();
        isMedicalStore[store] = active;
        emit MedicalStoreRegistered(store, active);
    }

    function registerPatient(bytes32 pid, address account, address clinician, bytes32 metaDigest)
        external
        onlyAdmin
    {
        if (patients[pid].exists) revert AlreadyExists();
        if (account == address(0)) revert ZeroAddress();
        if (!isClinician[clinician]) revert NotClinician();
        patients[pid] = Patient(account, clinician, metaDigest, true);
        emit PatientRegistered(pid, account, clinician);
    }

    function reassignClinician(bytes32 pid, address clinician) external onlyAdmin {
        Patient storage p = patients[pid];
        if (!p.exists) revert UnknownPatient();
        if (!isClinician[clinician]) revert NotClinician();
        emit ClinicianReassigned(pid, p.responsibleClinician, clinician);
        p.responsibleClinician = clinician;
    }

    // ==================================================================
    // Patient health information (responsible clinician)
    // ==================================================================
    function addPhiRecord(bytes32 rid, bytes32 pid, bytes32 digest) external onlyResponsible(pid) {
        if (digest == bytes32(0)) revert EmptyDigest();
        if (phiRecords[rid].digest != bytes32(0)) revert AlreadyExists();
        phiRecords[rid] = UserRecord(digest, pid, msg.sender, uint64(block.timestamp));
        emit PhiRecordAdded(rid, pid, digest, msg.sender);
    }

    function grantPhiAccess(bytes32 pid, address reader) external onlyResponsible(pid) {
        _phiAcl[pid][reader] = true;
        emit PhiAccessChanged(pid, reader, true, msg.sender);
    }

    function revokePhiAccess(bytes32 pid, address reader) external onlyResponsible(pid) {
        _phiAcl[pid][reader] = false;
        emit PhiAccessChanged(pid, reader, false, msg.sender);
    }

    function canReadPhi(bytes32 pid, address reader) public view returns (bool) {
        Patient storage p = patients[pid];
        if (!p.exists) return false;
        return reader == p.account || reader == p.responsibleClinician || _phiAcl[pid][reader];
    }

    /// @notice Personal records: administrator, responsible clinician and the patient.
    function canReadPersonal(bytes32 pid, address reader) external view returns (bool) {
        Patient storage p = patients[pid];
        if (!p.exists) return false;
        return reader == admin || reader == p.account || reader == p.responsibleClinician;
    }

    // ==================================================================
    // Prescriptions (any registered clinician may prescribe)
    // ==================================================================
    function addPrescription(bytes32 rxId, bytes32 pid, bytes32 digest) external onlyClinician {
        if (!patients[pid].exists) revert UnknownPatient();
        if (digest == bytes32(0)) revert EmptyDigest();
        if (prescriptions[rxId].digest != bytes32(0)) revert AlreadyExists();
        prescriptions[rxId] = UserRecord(digest, pid, msg.sender, uint64(block.timestamp));
        emit PrescriptionAdded(rxId, pid, digest, msg.sender);
    }

    function _requirePrescriberOrResponsible(bytes32 rxId) internal view {
        UserRecord storage rx = prescriptions[rxId];
        if (rx.digest == bytes32(0)) revert UnknownPrescription();
        if (msg.sender != rx.author && msg.sender != patients[rx.pid].responsibleClinician) {
            revert NotPrescriberOrResponsible();
        }
    }

    function grantRxAccess(bytes32 rxId, address reader) external {
        _requirePrescriberOrResponsible(rxId);
        _rxAcl[rxId][reader] = true;
        emit RxAccessChanged(rxId, reader, true, msg.sender);
    }

    function revokeRxAccess(bytes32 rxId, address reader) external {
        _requirePrescriberOrResponsible(rxId);
        _rxAcl[rxId][reader] = false;
        emit RxAccessChanged(rxId, reader, false, msg.sender);
    }

    function canReadRx(bytes32 rxId, address reader) external view returns (bool) {
        UserRecord storage rx = prescriptions[rxId];
        if (rx.digest == bytes32(0)) return false;
        Patient storage p = patients[rx.pid];
        return reader == rx.author || reader == p.responsibleClinician || reader == p.account || _rxAcl[rxId][reader];
    }
}
