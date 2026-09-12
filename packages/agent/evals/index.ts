import { main } from "./run";

// Only configuration errors are rendered. Provider errors are classified inside each trial.
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid benchmark configuration.");
  process.exitCode = 3;
}
