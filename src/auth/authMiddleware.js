const { expressjwt: jwt } = require("express-jwt");
const jwksRsa = require("jwks-rsa");

module.exports = jwt({
  secret: jwksRsa.expressJwtSecret({
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 5,
    jwksUri:
      "https://login.microsoftonline.com/f3211d0e-125b-42c3-86db-322b19a65a22/discovery/v2.0/keys",
  }),
  audience: "19d2d83b-f784-4e9f-85c5-555a2a681901",
  issuer:
    "https://login.microsoftonline.com/f3211d0e-125b-42c3-86db-322b19a65a22/v2.0",
  algorithms: ["RS256"],
});