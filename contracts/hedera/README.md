# Hedera ITS Support

Cloned at [`b4a68708c9a2e8098d1cac51d487b9d54661f66a`](https://github.com/axelarnetwork/interchain-token-service/tree/b4a68708c9a2e8098d1cac51d487b9d54661f66a).

## Overview

ITS contracts in this repo are modified to support Hedera Token Service. All new interchain tokens will be created via HTS, while existing HTS and ERC20 tokens are supported for registration. New HTS tokens will have `InterchainTokenService` as the sole Supply Key (MinterBurner) and Treasury (the contract that gets the newly minted coins). After minting, the Treasury transfers the tokens to the designated account. Before burning, the tokens are transfered back to the Treasury. ITS uses typical `allowance` and `transferFrom` to move tokens before burning. Certain ITS features are not supported due to HTS limitations, such as custom minters and initial supply.

### Hedera-related Notes

- Hedera contract and token "rent" and "expiry" are disabled on Hedera and not supported in this implementation.
- `IERC20` standard methods are supported, including `allowance` and `approve`. See [hip-218](https://hips.hedera.com/hip/hip-218) and [hip-376](https://hips.hedera.com/hip/hip-376). `mint` and `burn` are not supported.
- Unlike an EVM token, the [maximum supply for an HTS token is 2^63](https://docs.hedera.com/hedera/sdks-and-apis/sdks/token-service/define-a-token#token-properties). There's planned support for decimal translation in ITS.
- HTS tokens with the following keys are not supported by ITS: `kycKey`, `wipeKey`, `freezeKey`, `pauseKey`. `adminKey` can update existing keys, but cannot add new keys if they were not set during the creation of the token ([see here](https://docs.hedera.com/hedera/sdks-and-apis/sdks/token-service/update-a-token)).
- `HTS.sol` library is a subset of the Hedera provided system library [HederaTokenService](https://github.com/hashgraph/hedera-smart-contracts/blob/bc3a549c0ca062c51b0045fd1916fdaa0558a360/contracts/system-contracts/hedera-token-service/HederaTokenService.sol). Functions are modified to revert instead of returning response codes.
- Currently new tokens created via HTS EVM system contract can have **only one** Supply Key (Minter).
- Currently new tokens created via HTS EVM system contract must have the Treasury be the creator of the token.

### ITS-related Notes

- Both HTS tokens and ERC20 tokens are supported for registration.
- `InterchainTokenDeployer.sol` `deployedAddress` is not supported, since HTS tokens don't have deterministic addresses.
- When creating a new interchain token, `InterchainTokenService` and `TokenManager` are associated with the token.
- When registering a canonical token, only the `TokenManager` is associated with the token.
- `TokenHandler`'s `_giveInterchainToken` and `_takeInterchainToken` interact with the HTS directly — it is assumed the methods are called by the `InterchainTokenService` contract. `TokenManager` is still used for ERC20 tokens, lock-unlock and flow limits.
- Custom `minter` and `initialSupply` aren't currently supported when deploying a new interchain token on Hedera, due to the limitations of the HTS system contract.
