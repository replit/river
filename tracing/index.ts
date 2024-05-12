import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('river');
export default tracer;
