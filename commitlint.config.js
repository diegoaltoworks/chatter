module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // This repo's subjects often lead with a proper noun (WhatsApp, LangGraph,
    // Kutt) — the default case check has no allowance for that.
    "subject-case": [0],
    // The default 100 is tight once a squash-merge appends " (#123)"; several
    // of this repo's own subjects already run past it.
    "header-max-length": [2, "always", 120],
  },
};
