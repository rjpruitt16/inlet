#!/usr/bin/env node
import { main } from "./main.js";

// kafkajs schedules a negative timeout on newer Node versions, which prints
// a harmless TimeoutNegativeWarning in the middle of deploy output.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name !== "TimeoutNegativeWarning") console.warn(warning);
});

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
