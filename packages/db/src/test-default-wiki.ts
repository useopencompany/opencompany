// Ingestion writes resolve the workspace's default wiki before inserting (see
// requireIngestionWikiId in ./wikis), so the hand-rolled drizzle doubles in the
// ingestion unit tests need a `select` chain that answers that one lookup.
// Integration tests use the real migrations instead and never need this.

export const TEST_DEFAULT_WIKI_ID = "goat_wiki_default_test";

export function defaultWikiSelectStub(wikiId: string = TEST_DEFAULT_WIKI_ID) {
  return () => ({
    from: () => ({
      where: () => ({
        limit: async () => [{ id: wikiId }],
      }),
    }),
  });
}
