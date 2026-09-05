# RUC offline fixtures

These JSON files are small, synthetic contract fixtures shaped from the
observed RUCGO responses at commit `b41e2d552c6a9473fccd1efa0023d003bbdc3174`.
They contain no credentials, cookies, JWTs, personal names, or copied Dart
source. The tests intentionally exercise the risky invariants rather than
claiming that an online login is available:

- the portal may omit `events` for an empty day and mixes calendar/timetable
  categories in one response;
- the graduate payload joins `rwList`, `jgList`, and `jcfaList`, retains an
  unscheduled course, uses a week bitmap, and has adjacent plus lunch-separated
  periods;
- malformed joins fail before any existing item is overwritten.

The online RUC broker, CAS/WebView authentication, undergraduate timetable, and
exam endpoints remain explicit `unsupported` capabilities. A future captured
response may be added only after removing secrets and recording its provenance.
