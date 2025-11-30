/**
 * CLI testing utilities for mocking console and process
 */

/**
 * Mock console.log and console.error to capture output
 */
export function mockConsole() {
  const logs: string[] = [];
  const errors: string[] = [];

  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };

  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };

  return {
    /** Captured console.log output */
    logs,
    /** Captured console.error output */
    errors,
    /** Restore original console methods */
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
    /** Clear captured output */
    clear: () => {
      logs.length = 0;
      errors.length = 0;
    },
  };
}

/**
 * Mock process.exit to capture exit codes without actually exiting
 */
export function mockProcessExit() {
  let exitCode: number | undefined;
  let exitCalled = false;
  const originalExit = process.exit;

  // Create a custom error to throw instead of exiting
  class ProcessExitError extends Error {
    constructor(public code: number | undefined) {
      super(`process.exit(${code})`);
      this.name = 'ProcessExitError';
    }
  }

  process.exit = ((code?: number) => {
    exitCode = code;
    exitCalled = true;
    throw new ProcessExitError(code);
  }) as never;

  return {
    /** Get the exit code that was passed to process.exit */
    getExitCode: () => exitCode,
    /** Check if process.exit was called */
    wasCalled: () => exitCalled,
    /** Restore original process.exit */
    restore: () => {
      process.exit = originalExit;
    },
    /** The error class thrown when process.exit is called */
    ProcessExitError,
  };
}

/**
 * Capture both console output and process.exit in one helper
 */
export function mockCli() {
  const console = mockConsole();
  const processExit = mockProcessExit();

  return {
    console,
    processExit,
    restore: () => {
      console.restore();
      processExit.restore();
    },
  };
}

