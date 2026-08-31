'use strict';

// Scan the inbox for delivery-failure notices and mark bounced rows.
//   npm run bounces            (writes "Bounced" to the sheet, marks notices read)
//   npm run bounces -- --dry   (report only, no writes)
const { processBounces } = require('../services/bounces');

const dryRun = process.argv.includes('--dry');

processBounces({ dryRun })
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
