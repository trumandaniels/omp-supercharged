import { canonicalJson } from "./canonical.ts";
import { loadEvaluationSuite, runEvaluationSuite } from "./evaluation.ts";

const [suitePath] = process.argv.slice(2);

if (!suitePath) {
  process.stderr.write(
    "Usage: node --experimental-strip-types src/evaluate-cli.ts <evaluation-suite.json>\n",
  );
  process.exitCode = 2;
} else {
  try {
    const suite = await loadEvaluationSuite(suitePath);
    const result = await runEvaluationSuite(suite);
    const failedRuns = result.runs.filter((run) => !run.success);
    const providerFailures = failedRuns.filter(
      (run) => run.failureClass === "provider",
    ).length;
    const harnessFailures = failedRuns.filter(
      (run) => run.failureClass === "harness",
    ).length;
    const taskFailures = failedRuns.filter(
      (run) => run.failureClass === "task",
    ).length;
    process.stdout.write(
      `${canonicalJson({
        reportPath: result.reportPath,
        outputRoot: result.outputRoot,
        runCount: result.report.runCount,
        completePairs: result.report.completePairs,
        weakModelPairs: result.report.weakModelPairs,
        successes: result.runs.length - failedRuns.length,
        failures: failedRuns.length,
        providerFailures,
        harnessFailures,
        taskFailures,
      })}\n`,
    );
    if (failedRuns.length > 0) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Evaluation failed: ${message}\n`);
    process.exitCode = 1;
  }
}
