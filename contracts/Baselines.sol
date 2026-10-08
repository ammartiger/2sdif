// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title Baselines for the 2SDIF evaluation
/// @notice Each contract stores the same one-slot proof as TwoSDIFRegistry, keyed by the same device-bound
///         record id, so that gas and latency differences come only from how the digest is authenticated.

/// B0: single channel, trusted gateway. The registered gateway commits whatever digest it computed.
contract TrustedGatewayRegistry {
    address public immutable gateway;
    mapping(bytes32 => bytes32) private _proofs;
    event ProofCommitted(bytes32 indexed rid, bytes32 indexed deviceId, uint64 seq, bytes32 digest, address submitter);
    error NotGateway();
    error AlreadyCommitted(bytes32 rid);
    error EmptyDigest();

    constructor(address gateway_) {
        gateway = gateway_;
    }

    function recordId(bytes32 deviceId, uint64 seq) public pure returns (bytes32) {
        return keccak256(abi.encode(deviceId, seq));
    }

    function commit(bytes32 deviceId, uint64 seq, bytes32 digest) external {
        if (msg.sender != gateway) revert NotGateway();
        if (digest == bytes32(0)) revert EmptyDigest();
        bytes32 rid = recordId(deviceId, seq);
        if (_proofs[rid] != bytes32(0)) revert AlreadyCommitted(rid);
        _proofs[rid] = digest;
        emit ProofCommitted(rid, deviceId, seq, digest, msg.sender);
    }

    function getProof(bytes32 rid) external view returns (bytes32) {
        return _proofs[rid];
    }
}

/// B1: single channel, device signature (secp256k1, EIP-191), verified on chain with ecrecover against a
///     per-device address registered by the administrator.
contract DeviceSignedRegistry {
    string public constant DOMAIN_TAG = "2SDIF-B1";
    address public immutable admin;
    mapping(bytes32 => address) public deviceKey;
    mapping(bytes32 => bytes32) private _proofs;
    event ProofCommitted(bytes32 indexed rid, bytes32 indexed deviceId, uint64 seq, bytes32 digest, address submitter);
    error NotAdmin();
    error UnknownDevice();
    error AlreadyCommitted(bytes32 rid);
    error EmptyDigest();
    error InvalidSignature();

    constructor() {
        admin = msg.sender;
    }

    function registerDevice(bytes32 deviceId, address key) external {
        if (msg.sender != admin) revert NotAdmin();
        deviceKey[deviceId] = key;
    }

    function recordId(bytes32 deviceId, uint64 seq) public pure returns (bytes32) {
        return keccak256(abi.encode(deviceId, seq));
    }

    function message(bytes32 deviceId, uint64 seq, bytes32 digest) public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TAG, block.chainid, address(this), deviceId, seq, digest));
    }

    function commit(bytes32 deviceId, uint64 seq, bytes32 digest, bytes calldata signature) external {
        if (digest == bytes32(0)) revert EmptyDigest();
        address key = deviceKey[deviceId];
        if (key == address(0)) revert UnknownDevice();
        bytes32 rid = recordId(deviceId, seq);
        if (_proofs[rid] != bytes32(0)) revert AlreadyCommitted(rid);
        (address signer, ECDSA.RecoverError err, ) =
            ECDSA.tryRecover(MessageHashUtils.toEthSignedMessageHash(message(deviceId, seq, digest)), signature);
        if (err != ECDSA.RecoverError.NoError || signer != key) revert InvalidSignature();
        _proofs[rid] = digest;
        emit ProofCommitted(rid, deviceId, seq, digest, msg.sender);
    }

    function getProof(bytes32 rid) external view returns (bytes32) {
        return _proofs[rid];
    }
}

/// B2: single channel, device signature on NIST P-256 (the curve of common secure elements), verified with
///     the P256VERIFY precompile (EIP-7951, address 0x100, active since the Osaka upgrade).
contract DeviceP256Registry {
    string public constant DOMAIN_TAG = "2SDIF-B2";
    address public constant P256VERIFY = address(0x100);
    address public immutable admin;
    struct Key {
        bytes32 qx;
        bytes32 qy;
    }
    mapping(bytes32 => Key) public deviceKey;
    mapping(bytes32 => bytes32) private _proofs;
    event ProofCommitted(bytes32 indexed rid, bytes32 indexed deviceId, uint64 seq, bytes32 digest, address submitter);
    error NotAdmin();
    error UnknownDevice();
    error AlreadyCommitted(bytes32 rid);
    error EmptyDigest();
    error InvalidSignature();

    constructor() {
        admin = msg.sender;
    }

    function registerDevice(bytes32 deviceId, bytes32 qx, bytes32 qy) external {
        if (msg.sender != admin) revert NotAdmin();
        deviceKey[deviceId] = Key(qx, qy);
    }

    function recordId(bytes32 deviceId, uint64 seq) public pure returns (bytes32) {
        return keccak256(abi.encode(deviceId, seq));
    }

    /// @notice The device signs these bytes with ECDSA P-256 over SHA-256.
    function message(bytes32 deviceId, uint64 seq, bytes32 digest) public view returns (bytes memory) {
        return abi.encode(DOMAIN_TAG, block.chainid, address(this), deviceId, seq, digest);
    }

    function commit(bytes32 deviceId, uint64 seq, bytes32 digest, bytes32 r, bytes32 s) external {
        if (digest == bytes32(0)) revert EmptyDigest();
        Key storage k = deviceKey[deviceId];
        if (k.qx == bytes32(0) && k.qy == bytes32(0)) revert UnknownDevice();
        bytes32 rid = recordId(deviceId, seq);
        if (_proofs[rid] != bytes32(0)) revert AlreadyCommitted(rid);
        bytes32 h = sha256(message(deviceId, seq, digest));
        (bool ok, bytes memory out) = P256VERIFY.staticcall(abi.encodePacked(h, r, s, k.qx, k.qy));
        if (!ok || out.length != 32 || uint256(bytes32(out)) != 1) revert InvalidSignature();
        _proofs[rid] = digest;
        emit ProofCommitted(rid, deviceId, seq, digest, msg.sender);
    }

    function getProof(bytes32 rid) external view returns (bytes32) {
        return _proofs[rid];
    }
}
