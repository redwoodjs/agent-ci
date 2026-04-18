import fs from "node:fs";
import path from "node:path";

// ─── Pre-baked runner credentials ─────────────────────────────────────────────
// The GitHub Actions runner normally requires `config.sh` (a .NET binary) to
// generate .runner, .credentials and .credentials_rsaparams before run.sh can
// start. Each invocation cold-starts .NET 6, costing ~3-5s.
//
// Since the DTU mock accepts any credential values, we write these files
// directly with deterministic content. Both the Linux docker runner and the
// macOS VM runner use this: the underlying actions-runner binary is the same
// .NET process on both platforms, so the on-disk credentials are identical.
export function writeRunnerCredentials(
  runnerDir: string,
  runnerName: string,
  serverUrl: string,
): void {
  // .runner — tells run.sh who it is and where to connect
  const dotRunner = {
    agentId: 1,
    agentName: runnerName,
    poolId: 1,
    poolName: "Default",
    serverUrl: new URL(serverUrl).origin,
    gitHubUrl: serverUrl,
    workFolder: "_work",
    ephemeral: true,
  };
  fs.writeFileSync(path.join(runnerDir, ".runner"), JSON.stringify(dotRunner, null, 2));

  // .credentials — OAuth scheme that run.sh reads to authenticate with the DTU
  const dotCredentials = {
    scheme: "OAuth",
    data: {
      clientId: "00000000-0000-0000-0000-000000000000",
      authorizationUrl: `${serverUrl}/_apis/oauth2/token`,
      oAuthEndpointUrl: `${serverUrl}/_apis/oauth2/token`,
      requireFipsCryptography: "False",
    },
  };
  fs.writeFileSync(path.join(runnerDir, ".credentials"), JSON.stringify(dotCredentials, null, 2));

  // .credentials_rsaparams — RSA key the runner uses for token signing.
  // Format: RSAParametersSerializable JSON (ISerializable with lowercase keys
  // matching the RSAParametersSerializable constructor). The DTU mock never
  // validates signatures, so we use a static pre-generated RSA 2048-bit key.
  const dotRsaParams = {
    d: "CQpCI+sO2GD1N/JsHHI9zEhMlu5Fcc8mU4O2bO6iscOsagFjvEnTesJgydC/Go1HuOBlx+GT9EG2h7+juS0z2o5n8Mvt5BBxlK+tqoDOs8VfQ9CSUl3hqYRPeNdBfnA1w8ovLW0wqfPO08FWTLI0urYsnwjZ5BQrBM+D7zYeA0aCsKdo75bKmaEKnmqrtIEhb7hE45XQa32Yt0RPCPi8QcQAY2HLHbdWdZYDj6k/UuDvz9H/xlDzwYq6Yikk2RSMArFzaufxCGS9tBZNEACDPYgnZnEMXRcvsnZ9FYbq81KOSifCmq7Yocq+j3rY5zJCD+PIDY9QJwPxB4PGasRKAQ==",
    dp: "A0sY1oOz1+3uUMiy+I5xGuHGHOrEQPYspd1xGClBYYsa/Za0UDWS7V0Tn1cbRWfWtNe5vTpxcvwQd6UZBwrtHF6R2zyXFhE++PLPhCe0tH4C5FY9i9jUw9Vo8t44i/s5JUHU2B1mEptXFUA0GcVrLKS8toZSgqELSS2Q/YLRxoE=",
    dq: "GrLC9dPJ5n3VYw51ghCH7tybUN9/Oe4T8d9v4dLQ34RQEWHwRd4g3U3zkvuhpXFPloUTMmkxS7MF5pS1evrtzkay4QUTDv+28s0xRuAsw5qNTzuFygg8t93MvpvTVZ2TNApW6C7NFvkL9NbxAnU8+I61/3ow7i6a7oYJJ0hWAxE=",
    exponent: "AQAB",
    inverseQ:
      "8DVz9FSvEdt5W4B9OjgakZHwGfnhn2VLDUxrsR5ilC5tPC/IgA8C2xEfKQM1t+K/N3pAYHBYQ6EPgtW4kquBS/Sy102xbRI7GSCnUbRtTpWYPOaCn6EaxBNzwWzbp5vCbCGvFqlSu4+OBYRVe+iCj+gAnkmT/TKPhHHbTjJHvw==",
    modulus:
      "x0eoW2DD7xsW5YiorMN8pNHVvZk4ED1SHlA/bmVnRz5FjEDnQloMn0nBgIUHxoNArksknrp/FOVJv5sJHJTiRZkOp+ZmH7d3W3gmw63IxK2C5pV+6xfav9jR2+Wt/6FMYMgG2utBdF95oif1f2XREFovHoXkWms2l0CPLLHVPO44Hh9EEmBmjOeMJEZkulHJ44z9y8e+GZ2nYqO0ZiRWQcRObZ0vlRaGg6PPOl4ltay0BfNksMB3NDtlhkdVkAEFQxEaZZDK9NtkvNljXCioP3TyTAbqNUGsYCA5D+IHGZT9An99J9vUqTFP6TKjqUvy9WNiIzaUksCySA0a4SVBkQ==",
    p: "8fgAdmWy+sTzAN19fYkWMQqeC7t1BCQMo5z5knfVLg8TtwP9ZGqDtoe+r0bGv3UgVsvvDdP/QwRvRVP+5G9l999Y6b4VbSdUbrfPfOgjpPDmRTQzHDve5jh5xBENQoRXYm7PMgHGmjwuFsE/tKtSGTrvt2Z3qcYAo0IOqLLhYmE=",
    q: "0tXx4+P7gUWePf92UJLkzhNBClvdnmDbIt52Lui7YCARczbN/asCDJxcMy6Bh3qmIx/bNuOUrfzHkYZHfnRw8AGEK80qmiLLPI6jrUBOGRajmzemGQx0W8FWalEQfGdNIv9R2nsegDRoMq255Zo/qX60xQ6abpp0c6UNhVYSjTE=",
  };
  fs.writeFileSync(path.join(runnerDir, ".credentials_rsaparams"), JSON.stringify(dotRsaParams));
}
