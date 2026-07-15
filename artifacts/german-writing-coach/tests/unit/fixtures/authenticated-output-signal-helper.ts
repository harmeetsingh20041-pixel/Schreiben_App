import { withAuthenticatedOutput } from "../../../scripts/run-authenticated-playwright";

void withAuthenticatedOutput(async (outputDirectory) => {
  process.stdout.write(`${outputDirectory}\n`);
  await new Promise<never>(() => {
    setInterval(() => undefined, 60_000);
  });
});
