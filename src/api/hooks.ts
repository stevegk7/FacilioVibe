import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { provider } from './provider';
import type { AssetSearch, WorkOrderDraft } from './types';

// All portfolio reads go through these hooks — components never call the
// provider directly for cacheable data, so keys stay consistent app-wide.

export function useSites() {
  return useQuery({
    queryKey: ['sites'],
    queryFn: () => provider.listSites({ pageSize: 200 }).then((p) => p.data),
  });
}

export function useBuildings() {
  return useQuery({
    queryKey: ['buildings'],
    queryFn: () => provider.listBuildings(),
  });
}

export function useFloors() {
  return useQuery({
    queryKey: ['floors'],
    queryFn: () => provider.listFloors(),
  });
}

export function useAssetSearch(search: AssetSearch, enabled = true) {
  return useQuery({
    // Spread the scope into the key — object identity must not matter.
    queryKey: [
      'assets',
      'search',
      search.scope?.siteId ?? null,
      search.scope?.buildingId ?? null,
      search.scope?.floorId ?? null,
      search.text ?? '',
    ],
    queryFn: () => provider.searchAssets(search),
    enabled,
  });
}

export function useAsset(id: number | null) {
  return useQuery({
    queryKey: ['asset', id],
    queryFn: () => provider.getAsset(id as number),
    enabled: id !== null,
  });
}

// ---- work orders (2.2–2.4) ----

export function useWorkOrdersForAsset(assetId: number | null) {
  return useQuery({
    queryKey: ['workorders', 'asset', assetId],
    queryFn: () => provider.listWorkOrdersForAssets([assetId as number]),
    enabled: assetId !== null,
  });
}

export function useWorkOrderTasks(workOrderId: number | null) {
  return useQuery({
    queryKey: ['workorder', workOrderId, 'tasks'],
    queryFn: () => provider.listWorkOrderTasks(workOrderId as number),
    enabled: workOrderId !== null,
  });
}

export function useWorkOrderStatuses() {
  return useQuery({
    queryKey: ['workorder-statuses'],
    queryFn: () => provider.getWorkOrderStatuses(),
    // The catalogue is org config, not record data — hold it much longer.
    staleTime: 60 * 60 * 1000,
  });
}

export function useAddWorkOrderTask(workOrderId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (subject: string) => provider.addWorkOrderTask(workOrderId, subject),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workorder', workOrderId, 'tasks'] });
    },
  });
}

export function useSetTaskStatus(workOrderId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, closed }: { taskId: number; closed: boolean }) =>
      provider.setWorkOrderTaskStatus(workOrderId, taskId, closed),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['workorder', workOrderId, 'tasks'] }),
  });
}

export function useChangeWorkOrderStatus(assetId: number | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workOrderId, status }: { workOrderId: number; status: string }) =>
      provider.changeWorkOrderStatus(workOrderId, status),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['workorders', 'asset', assetId] }),
  });
}

export function useCreateWorkOrder(assetId: number | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: WorkOrderDraft) => provider.createWorkOrder(draft),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['workorders', 'asset', assetId] }),
  });
}
