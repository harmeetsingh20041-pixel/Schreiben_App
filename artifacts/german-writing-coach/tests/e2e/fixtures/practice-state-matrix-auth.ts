const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";

export function useAuth() {
  return {
    activeMembershipId: "membership-1",
    activeWorkspaceId: WORKSPACE_ID,
    authMode: "supabase" as const,
    role: "student" as const,
    user: { id: STUDENT_ID },
    logout: async () => undefined,
    selectActiveMembership: async () => undefined,
    workspaceMemberships: [
      {
        id: "membership-1",
        workspace_id: WORKSPACE_ID,
        workspace_name: "Pilot School",
        role: "student" as const,
      },
      {
        id: "membership-2",
        workspace_id: "44444444-4444-4444-8444-444444444444",
        workspace_name: "Partner School",
        role: "student" as const,
      },
    ],
  };
}
