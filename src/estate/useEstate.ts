/**
 * The estate query.
 *
 * Two policies here that are not defaults, and both matter:
 *
 * 1. `refetchOnMount: false` overrides the app-wide `'always'` in
 *    queryClient.ts. That default is right for small reads and wrong for this
 *    one: the estate is seven paged CMMS calls plus ~536 KB of CAD plans, and
 *    AppShell unmounts the screen on every tab switch. Left inherited, a user
 *    flipping between 3D and AR would re-fetch the whole estate each way and
 *    rebuild the scene with it.
 *
 * 2. The result seeds the caches the OTHER screens read. The estate fetch is the
 *    wide one — full asset rows, because an invalid field in `select` silently
 *    nulls the response — and every narrow list is a projection of it. Seeding
 *    means opening Estate then Portfolio costs zero extra calls. It does not
 *    work in reverse: a narrow fetch cannot satisfy the estate.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { provider } from '../api/provider';
import type { EstateRaw } from './types';

export const ESTATE_KEY = ['estate'] as const;

interface RawLookup {
  id?: number;
  name?: string;
}
interface RawRowLike {
  id?: number;
  name?: string;
  floorlevel?: number;
  site?: RawLookup | null;
  building?: RawLookup | null;
  floor?: RawLookup | null;
  space?: RawLookup | null;
  spaceCategory?: string;
  category?: string | RawLookup;
  qrVal?: string;
  subject?: string;
  description?: string;
  moduleState?: string;
  priority?: string;
  dueDate?: string;
  createdTime?: string;
  assignedTo?: RawLookup | string;
  resource?: RawLookup | null;
}

const nameOf = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : ((v as RawLookup | null)?.name ?? undefined);

export function useEstate() {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ESTATE_KEY,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    async queryFn(): Promise<EstateRaw> {
      const raw = await provider.loadEstate();
      const rows = raw as unknown as Record<string, RawRowLike[]>;

      // Keys are byte-identical to the ones hooks.ts and DashboardScreen build,
      // or the seeding silently does nothing.
      queryClient.setQueryData(
        ['sites'],
        rows.sites.map((s) => ({ id: s.id!, name: s.name! })),
      );
      queryClient.setQueryData(
        ['buildings'],
        rows.buildings.map((b) => ({ id: b.id!, name: b.name!, siteId: b.site?.id })),
      );
      queryClient.setQueryData(
        ['floors'],
        rows.floors.map((f) => ({
          id: f.id!,
          name: f.name!,
          floorLevel: typeof f.floorlevel === 'number' ? f.floorlevel : undefined,
          buildingId: f.building?.id,
          siteId: f.site?.id,
        })),
      );
      queryClient.setQueryData(
        ['assets', 'search', null, null, null, ''],
        rows.assets.map((a) => ({
          id: a.id!,
          name: a.name!,
          category: nameOf(a.category),
          spaceId: a.space?.id,
          spaceName: a.space?.name,
          qrVal: a.qrVal,
        })),
      );
      queryClient.setQueryData(
        ['workorders', 'all'],
        rows.workOrders.map((w) => ({
          id: w.id!,
          subject: w.subject ?? '',
          description: w.description,
          status: nameOf(w.moduleState),
          priority: nameOf(w.priority),
          resourceId: w.resource?.id,
          resourceName: w.resource?.name,
          assignedTo: nameOf(w.assignedTo),
          dueDate: w.dueDate,
          createdTime: w.createdTime,
        })),
      );

      return raw;
    },
  });
}
