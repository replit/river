# Operations

## Core distinctions from async/await

**Statelessness**: Operations do not do anything by themselves. They describe
what should be done when the operation is run. Unlike Promises that execute
autonomously, Effection operations require explicit execution via `run()` or
`main()`.

**Interruptibility**: Operations can be cancelled gracefully, preventing
resource leaks. In a race condition, Promise-based code hangs until all
branches complete, while Effection exits as soon as the winner resolves.

## Execution model

Operations compose through `yield*` syntax (Effection's counterpart to
`await`). Every operation in Effection eventually boils down to a combination
of just two primitive operations: `action()` and `resource()`.

## Cleanup and resource management

The critical innovation is bundling teardown logic with setup. For example, the
`sleep()` implementation returns a cleanup function that clears the timeout,
ensuring we never leak a timeout effect.

This approach mirrors UI component hierarchies where parent unmounting
automatically handles child cleanup, allowing cleanup to happen both
automatically and relentlessly.
