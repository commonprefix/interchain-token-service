# Hedera ITS Support

Cloned at `7df851d8a4ec4df819961d704bf3067ee8d37521`.

### Hedera-related Notes

- Hedera contract and token "rent" and "expiry" are disabled on Hedera and not supported in this implementation.
- `IERC20` standard methods are supported, including `allowance` and `approve`. See [hip-218](https://hips.hedera.com/hip/hip-218) and [hip-376](https://hips.hedera.com/hip/hip-376).
- Unlike an EVM token, the [maximum supply for an HTS token is 2^63](https://docs.hedera.com/hedera/sdks-and-apis/sdks/token-service/define-a-token#token-properties). There's planned support for decimal conversion.
- HTS tokens with the following keys are not supported by ITS: `kycKey`, `wipeKey`, `freezeKey`, `pauseKey`.

### ITS-related Notes

- Both HTS tokens and ERC20 tokens are supported on Hedera.
- `InterchainTokenDeployer.sol` `deployedAddress` is not supported.
- When creating a new interchain token, only `InterchainTokenService` and `TokenManager` are associated with the token.
- When registering a canonical token, only the `TokenManager` are associated with the token.
