#!/usr/bin/env node

import fs from "node:fs";

const mode = process.argv[2];
const eventsFile = process.env.DNS_SD_EVENTS_FILE;
const record = (event) => {
  if (eventsFile) fs.appendFileSync(eventsFile, `${event} ${process.pid}\n`);
};

record(`start-${mode}`);
const stop = () => {
  record(`stop-${mode}`);
  process.exit(0);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

if (mode === "-B") {
  process.stdout.write("Browsing for _mcp._tcp.local\n");
  process.stdout.write("12:00:00 Add 2 4 local. NeoXPhone _mcp._tcp.\n");
} else if (mode === "-L") {
  process.stdout.write("NeoXPhone._mcp._tcp.local. can be reached via 127.0.0.1:43123 (interface 12)\n");
} else {
  process.exitCode = 2;
}

setInterval(() => {}, 60_000);
