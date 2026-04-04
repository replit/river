# Thinking in Effection

Effection delivers three core guarantees:

1. **Parent-Child Lifetime Binding**: No operation runs longer than its parent.
   Child operations automatically terminate when their parent completes,
   mirroring how memory is bound to function scope.

2. **Guaranteed Completion**: Every operation exits fully. Unlike async/await
   functions vulnerable to the Await Event Horizon, Effection ensures finally
   blocks execute reliably, enabling proper cleanup and resource management.

3. **Familiar JavaScript Syntax**: The framework uses standard JavaScript
   constructs (`let`, `const`, `if`, `for`, `while`, `switch`, `try/catch/finally`)
   while deliberately avoiding `async`/`await`, which cannot model structured
   concurrency. Instead, it leverages generator functions.

The philosophical shift Effection promotes is reframing asynchronous operations:
instead of thinking they "will run as long as needed," developers should
understand they "run only as long as needed." This prevents runtime pollution
and enables predictable cleanup patterns similar to synchronous programming.
