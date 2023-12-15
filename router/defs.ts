import { AnyService } from './builder';

/**
 * Defines a type for a collection service definitions. Should be
 * build with the {@link buildServiceDefs} function.
 * @template T - An array of services.
 */
export type ServiceDefs<T extends AnyService[] = AnyService[]> = {
  [K in T[number]['name']]: T[number];
};

/**
 * Builds service definitions based on an array of services.
 * @param services - The array of services.
 * @returns The service definitions.
 */
export function buildServiceDefs<T extends AnyService[]>(
  services: T,
): ServiceDefs<T> {
  return services.reduce((acc, service) => {
    acc[service.name as keyof ServiceDefs<T>] = service;
    return acc;
  }, {} as ServiceDefs<T>);
}
