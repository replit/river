import { AnyService } from './builder';

/**
 * Defines a type for a collection service definitions. Should be
 * build with the {@link buildServiceDefs} function.
 * @template T - An array of services.
 */
export type ServiceDefs<T extends Array<AnyService> = Array<AnyService>> = {
  [K in T[number]['name']]: Extract<T[number], { name: K }>;
};

/**
 * Builds service definitions based on an array of services.
 * @param services - The array of services.
 * @returns The service definitions.
 */
export function buildServiceDefs<T extends Array<AnyService>>(
  services: T,
): ServiceDefs<T> {
  // we use reduce for building objects from arrays (buildServiceDefs) which typescript cannot prove to be safe
  return services.reduce((acc, service) => {
    acc[service.name as keyof ServiceDefs<T>] = service as Extract<
      T[number],
      { name: T[number]['name'] }
    >;
    return acc;
    /* eslint-disable-next-line @typescript-eslint/prefer-reduce-type-parameter */
  }, {} as ServiceDefs<T>);
}
