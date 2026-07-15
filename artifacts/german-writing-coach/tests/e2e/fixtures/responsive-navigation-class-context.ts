const assignments = [
  {
    id: "assignment-1",
    batch_id: "33333333-3333-4333-8333-333333333333",
    batch_name: "A2 Evening",
    level: "A2",
  },
  {
    id: "assignment-2",
    batch_id: "55555555-5555-4555-8555-555555555555",
    batch_name: "B1 Morning",
    level: "B1",
  },
];

export function useStudentClass() {
  return {
    activeAssignment: assignments[0],
    activeBatchId: assignments[0].batch_id,
    assignments,
    isLoading: false,
    selectActiveBatch: () => undefined,
  };
}
