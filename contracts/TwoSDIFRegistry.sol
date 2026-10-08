// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title 2SDIF registry: witness-verified integrity proofs and contract-enforced access control
/// @notice Device records are accepted only with an attestation signed by the registered witness.
///         The gateway that submits them is untrusted: it cannot change the digest or forge the attestation.
///         User records and ACL changes are signed by the users themselves (msg.sender is checked).
contract TwoSDIFRegistry {
    string public constant DOMAIN_TAG = "2SDIF-v2";

    address public admin;
    address public witness;

    // Witness rotation is announced and delayed, so an auditor can see it before it takes effect.
    uint64 public immutable witnessDelay;
    address public pendingWitness;
    uint64 public pendingWitnessAt;

    // ------------------------------------------------------------------
    // Device proofs (dual channel path)
    // ------------------------------------------------------------------
    // A record identifier is derived from the device identifier and the device's sequence number,
    // rid = keccak256(abi.encode(did, seq)), so a device can only ever occupy its own identifiers.
    // Only the attested digest is kept in storage (one slot); the device, sequence number and witness
    // time are emitted with the event, and the device binding is implied by rid.
    mapping(bytes32 => bytes32) private _proofs; // rid => digest

    // Batched commitments: k attested proofs, one storage write. Every attestation is verified and every
    // record is announced with ProofCommitted (the auditor is unchanged); only the Merkle root of the
    // leaves H(0x00, rid, digest) is stored, and a client verifies a record with a Merkle path to it.
    struct Attested {
        bytes32 deviceId;
        uint64 seq;
        bytes32 digest;
        uint64 witnessTime;
        bytes signature;
    }
    mapping(bytes32 => uint64) public batchRoots; // root => block number in which it was committed

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
    event ProofCommitted(bytes32 indexed rid, bytes32 indexed deviceId, uint64 seq, bytes32 digest, uint64 witnessTime, address submitter);
    event BatchCommitted(bytes32 indexed root, uint256 size, address submitter);
    event WitnessChangeProposed(address indexed current, address indexed proposed, uint64 effectiveAt);
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
    error WitnessChangeNotReady();
    error NotAllowedReader();

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
        if (msg.sender != p.responsibleClinician || !isClinician[msg.sender]) revert NotResponsibleClinician();
        _;
    }

    constructor(address witness_, uint64 witnessDelay_) {
        if (witness_ == address(0)) revert ZeroAddress();
        admin = msg.sender;
        witness = witness_;
        witnessDelay = witnessDelay_;
        emit WitnessChanged(address(0), witness_);
    }

    // ==================================================================
    // Witness management: announce, wait, activate
    // ==================================================================
    function proposeWitness(address newWitness) external onlyAdmin {
        if (newWitness == address(0)) revert ZeroAddress();
        pendingWitness = newWitness;
        pendingWitnessAt = uint64(block.timestamp) + witnessDelay;
        emit WitnessChangeProposed(witness, newWitness, pendingWitnessAt);
    }

    function activateWitness() external onlyAdmin {
        if (pendingWitness == address(0) || block.timestamp < pendingWitnessAt) revert WitnessChangeNotReady();
        emit WitnessChanged(witness, pendingWitness);
        witness = pendingWitness;
        pendingWitness = address(0);
        pendingWitnessAt = 0;
    }

    // ==================================================================
    // Dual channel path: attested device proofs
    // ==================================================================

    /// @notice Device-bound record identifier.
    function recordId(bytes32 deviceId, uint64 seq) public pure returns (bytes32) {
        return keccak256(abi.encode(deviceId, seq));
    }

    /// @notice The message the witness signs (EIP-191 personal_sign over this 32-byte value).
    ///         Chain id and contract address are bound in to prevent cross-deployment replay.
    function attestationMessage(bytes32 deviceId, uint64 seq, bytes32 digest, uint64 witnessTime)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(DOMAIN_TAG, block.chainid, address(this), deviceId, seq, digest, witnessTime));
    }

    /// @notice Commit a device proof. Anyone may submit (normally the fog gateway; also the device or an
    ///         auditor holding the attestation), but only a digest attested by the registered witness is
    ///         accepted, and only once per record id.
    function commitProof(bytes32 deviceId, uint64 seq, bytes32 digest, uint64 witnessTime, bytes calldata signature)
        external
    {
        if (digest == bytes32(0)) revert EmptyDigest();
        bytes32 rid = recordId(deviceId, seq);
        if (_proofs[rid] != bytes32(0)) revert AlreadyCommitted(rid);
        bytes32 ethSigned = MessageHashUtils.toEthSignedMessageHash(attestationMessage(deviceId, seq, digest, witnessTime));
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(ethSigned, signature);
        if (err != ECDSA.RecoverError.NoError || signer != witness) revert InvalidAttestation();
        _proofs[rid] = digest;
        emit ProofCommitted(rid, deviceId, seq, digest, witnessTime, msg.sender);
    }

    function getProof(bytes32 rid) external view returns (bytes32 digest) {
        return _proofs[rid];
    }

    function _verifyAttestation(Attested calldata a) private view returns (bytes32 rid) {
        if (a.digest == bytes32(0)) revert EmptyDigest();
        bytes32 ethSigned = MessageHashUtils.toEthSignedMessageHash(attestationMessage(a.deviceId, a.seq, a.digest, a.witnessTime));
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(ethSigned, a.signature);
        if (err != ECDSA.RecoverError.NoError || signer != witness) revert InvalidAttestation();
        return recordId(a.deviceId, a.seq);
    }

    function batchLeaf(bytes32 rid, bytes32 digest) public pure returns (bytes32) {
        return keccak256(abi.encode(bytes1(0x00), rid, digest));
    }

    function _node(bytes32 l, bytes32 r) private pure returns (bytes32) {
        return keccak256(abi.encode(bytes1(0x01), l, r));
    }

    /// @notice Commit k attested proofs in one transaction with a single storage write (the Merkle root).
    ///         Pairs are hashed left to right; an unpaired node is carried up unchanged.
    function commitBatch(Attested[] calldata items) external returns (bytes32 root) {
        uint256 n = items.length;
        if (n == 0) revert EmptyDigest();
        bytes32[] memory level = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            Attested calldata a = items[i];
            bytes32 rid = _verifyAttestation(a);
            level[i] = batchLeaf(rid, a.digest);
            emit ProofCommitted(rid, a.deviceId, a.seq, a.digest, a.witnessTime, msg.sender);
        }
        while (n > 1) {
            uint256 half = n / 2;
            for (uint256 i; i < half; ++i) level[i] = _node(level[2 * i], level[2 * i + 1]);
            if (n % 2 == 1) level[half] = level[n - 1];
            n = half + (n % 2);
        }
        root = level[0];
        if (batchRoots[root] != 0) revert AlreadyCommitted(root);
        batchRoots[root] = uint64(block.number);
        emit BatchCommitted(root, items.length, msg.sender);
    }

    /// @notice Check that (rid, digest) is leaf `index` of a committed batch of `size` leaves.
    function verifyBatched(bytes32 rid, bytes32 digest, uint256 index, uint256 size, bytes32[] calldata path, bytes32 root)
        external
        view
        returns (bool)
    {
        if (batchRoots[root] == 0 || index >= size) return false;
        bytes32 h = batchLeaf(rid, digest);
        uint256 p;
        for (uint256 n = size; n > 1; n = n / 2 + (n % 2)) {
            if (index % 2 == 1) {
                if (p >= path.length) return false;
                h = _node(path[p++], h);
            } else if (index + 1 < n) {
                if (p >= path.length) return false;
                h = _node(h, path[p++]);
            } // else: unpaired last node, carried up
            index /= 2;
        }
        return p == path.length && h == root;
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
        if (!isClinician[reader]) revert NotAllowedReader(); // health information is shared with clinicians only
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
        if (reader == p.account) return true;
        if (!isClinician[reader]) return false; // deactivated clinicians lose access, including grants
        return reader == p.responsibleClinician || _phiAcl[pid][reader];
    }

    /// @notice Personal records: administrator, responsible clinician and the patient.
    function canReadPersonal(bytes32 pid, address reader) external view returns (bool) {
        Patient storage p = patients[pid];
        if (!p.exists) return false;
        return reader == admin || reader == p.account || (reader == p.responsibleClinician && isClinician[reader]);
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
        if (!isClinician[msg.sender] || (msg.sender != rx.author && msg.sender != patients[rx.pid].responsibleClinician)) {
            revert NotPrescriberOrResponsible();
        }
    }

    function grantRxAccess(bytes32 rxId, address reader) external {
        _requirePrescriberOrResponsible(rxId);
        if (!isMedicalStore[reader] && !isClinician[reader]) revert NotAllowedReader(); // stores and clinicians only
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
        if (reader == p.account) return true;
        if (isClinician[reader] && (reader == rx.author || reader == p.responsibleClinician)) return true;
        return _rxAcl[rxId][reader] && (isMedicalStore[reader] || isClinician[reader]);
    }
}
