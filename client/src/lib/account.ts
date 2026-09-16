/**
 * Portal auth + favorites helpers for the consumer portal at /account/*.
 *
 * Backed by /api/account/* (server/account.ts). All fetches include
 * credentials so the session cookie travels with each request.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export type AccountMe = {
  id: number;
  email: string;
  name: string | null;
  emailVerified: boolean;
};

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: "include", ...init });
  if (!r.ok && r.status !== 401) throw new Error(`${url} → ${r.status}`);
  return (await r.json()) as T;
}

/** Current portal user (null if not signed in). */
export function useAccount() {
  return useQuery<AccountMe | null>({
    queryKey: ["/api/account/me"],
    queryFn: async () => {
      const r = await fetch("/api/account/me", { credentials: "include" });
      if (r.status === 401) return null;
      const j = await r.json();
      return j.user ?? null;
    },
    // Auth state changes are rare — don't refetch on window focus.
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
}

/** Request a magic-link email. */
export function useRequestMagicLink() {
  return useMutation({
    mutationFn: async (email: string) => {
      const r = await fetch("/api/account/auth/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!r.ok) throw new Error("Failed to send magic link");
      return r.json();
    },
  });
}

/** Sign out — clears cookie + invalidates the cached user. */
export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await fetch("/api/account/logout", {
        method: "POST",
        credentials: "include",
      });
    },
    onSuccess: () => qc.setQueryData(["/api/account/me"], null),
  });
}

// ---- Favorites -----------------------------------------------------------

export type Favorite = {
  id: number;
  accountUserId: number;
  mlsId: string;
  createdAt: string;
};

export function useFavorites() {
  return useQuery<Favorite[]>({
    queryKey: ["/api/account/favorites"],
    queryFn: async () => {
      const r = await fetch("/api/account/favorites", { credentials: "include" });
      if (r.status === 401) return [];
      const j = await r.json();
      return j.favorites ?? [];
    },
    staleTime: 30_000,
  });
}

export function useAddFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (mlsId: string) => {
      const r = await fetch("/api/account/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mlsId }),
      });
      if (!r.ok) throw new Error("Failed to favorite");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/account/favorites"] }),
  });
}

export function useRemoveFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (mlsId: string) => {
      const r = await fetch(
        `/api/account/favorites/${encodeURIComponent(mlsId)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!r.ok) throw new Error("Failed to remove favorite");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/account/favorites"] }),
  });
}

/** Convenience: is this MLS id in the user's favorites set? */
export function useIsFavorited(mlsId: string | undefined): boolean {
  const { data } = useFavorites();
  if (!mlsId || !data) return false;
  return data.some((f) => f.mlsId === mlsId);
}

// ---- Saved searches -----------------------------------------------------

export type SavedSearch = {
  id: number;
  name: string;
  filters: string; // JSON-serialised filter set
  frequency: "instant" | "daily" | "weekly" | "monthly";
  emailAlerts: boolean;
  active: boolean;
  lastSentAt: string | null;
  lastMatchCount: number;
  createdAt: string;
};

export function useSavedSearches() {
  return useQuery<SavedSearch[]>({
    queryKey: ["/api/account/searches"],
    queryFn: async () => {
      const r = await fetch("/api/account/searches", { credentials: "include" });
      if (r.status === 401) return [];
      const j = await r.json();
      return j.searches ?? [];
    },
    staleTime: 30_000,
  });
}

export function useCreateSavedSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      name: string;
      filters: Record<string, unknown>;
      frequency?: "instant" | "daily" | "weekly" | "monthly";
      emailAlerts?: boolean;
    }) => {
      const r = await fetch("/api/account/searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error("Failed to save search");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/account/searches"] }),
  });
}

export function useUpdateSavedSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      id: number;
      name?: string;
      filters?: Record<string, unknown>;
      frequency?: "instant" | "daily" | "weekly" | "monthly";
      emailAlerts?: boolean;
      active?: boolean;
    }) => {
      const { id, ...rest } = payload;
      const r = await fetch(`/api/account/searches/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(rest),
      });
      if (!r.ok) throw new Error("Failed to update search");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/account/searches"] }),
  });
}

export function useDeleteSavedSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/account/searches/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error("Failed to delete search");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/account/searches"] }),
  });
}

// ---- Property notes -----------------------------------------------------

export type PropertyNote = {
  id: number;
  accountUserId: number;
  mlsId: string;
  note: string;
  createdAt: string;
  updatedAt: string;
};

export function useNotes() {
  return useQuery<PropertyNote[]>({
    queryKey: ["/api/account/notes"],
    queryFn: async () => {
      const r = await fetch("/api/account/notes", { credentials: "include" });
      if (r.status === 401) return [];
      const j = await r.json();
      return j.notes ?? [];
    },
    staleTime: 30_000,
  });
}

export function useNote(mlsId: string | undefined) {
  return useQuery<PropertyNote | null>({
    queryKey: ["/api/account/notes", mlsId],
    enabled: Boolean(mlsId),
    queryFn: async () => {
      if (!mlsId) return null;
      const r = await fetch(`/api/account/notes/${encodeURIComponent(mlsId)}`, {
        credentials: "include",
      });
      if (r.status === 401 || !r.ok) return null;
      const j = await r.json();
      return j.note ?? null;
    },
    staleTime: 15_000,
  });
}

export function useSaveNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { mlsId: string; note: string }) => {
      const r = await fetch(
        `/api/account/notes/${encodeURIComponent(payload.mlsId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ note: payload.note }),
        },
      );
      if (!r.ok) throw new Error("Failed to save note");
      return r.json();
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["/api/account/notes"] });
      qc.invalidateQueries({ queryKey: ["/api/account/notes", vars.mlsId] });
    },
  });
}

// ---- Tour requests ------------------------------------------------------

export type TourRequest = {
  id: number;
  listingId: string;
  leadId: number | null;
  scheduledFor: string;
  status: string; // requested | confirmed | cancelled | completed
  notes: string | null;
  createdAt: string;
};

export function useTours() {
  return useQuery<TourRequest[]>({
    queryKey: ["/api/account/tours"],
    queryFn: async () => {
      const r = await fetch("/api/account/tours", { credentials: "include" });
      if (r.status === 401) return [];
      const j = await r.json();
      return j.tours ?? [];
    },
    staleTime: 30_000,
  });
}

export function useRequestTour() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { mlsId: string; preferredAt: string; notes?: string }) => {
      const r = await fetch("/api/account/tours", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error("Failed to request tour");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/account/tours"] }),
  });
}

export function useCancelTour() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/account/tours/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error("Failed to cancel tour");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/account/tours"] }),
  });
}

// ---- Market report subscriptions ----------------------------------------

export type MarketReportSub = {
  id: number;
  accountUserId: number;
  neighbourhoodSlug: string | null;
  frequency: "daily" | "weekly" | "monthly";
  active: boolean;
  lastSentAt: string | null;
  createdAt: string;
};

export function useMarketReports() {
  return useQuery<MarketReportSub[]>({
    queryKey: ["/api/account/market-reports"],
    queryFn: async () => {
      const r = await fetch("/api/account/market-reports", { credentials: "include" });
      if (r.status === 401) return [];
      const j = await r.json();
      return j.subs ?? [];
    },
    staleTime: 30_000,
  });
}

export function useSubscribeMarketReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      neighbourhoodSlug?: string | null;
      frequency?: "daily" | "weekly" | "monthly";
    }) => {
      const r = await fetch("/api/account/market-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error("Failed to subscribe");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/account/market-reports"] }),
  });
}

export function useUpdateMarketReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      id: number;
      frequency?: "daily" | "weekly" | "monthly";
      active?: boolean;
    }) => {
      const { id, ...rest } = payload;
      const r = await fetch(`/api/account/market-reports/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(rest),
      });
      if (!r.ok) throw new Error("Failed to update");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/account/market-reports"] }),
  });
}

export function useDeleteMarketReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/account/market-reports/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error("Failed to delete");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/account/market-reports"] }),
  });
}

// ---- Documents to sign (deals & e-signature) --------------------------------
import type { PortalDocument } from "./esign-types";

export function usePortalDocuments() {
  return useQuery<PortalDocument[]>({
    queryKey: ["/api/account/documents"],
    queryFn: async () => {
      const r = await fetch("/api/account/documents", { credentials: "include" });
      if (r.status === 401) return [];
      if (!r.ok) throw new Error(`/api/account/documents → ${r.status}`);
      return r.json();
    },
    staleTime: 30_000,
  });
}
