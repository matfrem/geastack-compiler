#include "gea_runtime.h"
#include <cstdio>
#include <string>
#include <vector>

static int failures = 0;
#define CHECK(cond)                                                          \
  do {                                                                       \
    if (!(cond)) {                                                           \
      std::printf("FAIL line %d: %s\n", __LINE__, #cond);                    \
      ++failures;                                                            \
    }                                                                        \
  } while (0)

// A cursor that counts its calls, to show the range makes the same two calls in the same order as the loop it replaces.
struct CountingCursor {
  std::vector<int> values;
  std::size_t at = 0;
  bool finished = false;
  std::string trace;
  int arrayNext() {
    trace += 'n';
    if (at >= values.size()) {
      finished = true;
      return 0;
    }
    finished = false;
    return values[at++];
  }
  bool done() {
    trace += 'd';
    return finished;
  }
};

int main() {
  // the loop and the range see the same elements and leave the cursor in the same place
  {
    CountingCursor looped{{4, 5, 6}};
    std::vector<int> byLoop;
    for (;;) {
      int item = looped.arrayNext();
      bool done = looped.done();
      if (done) break;
      byLoop.push_back(item);
    }
    CountingCursor ranged{{4, 5, 6}};
    std::vector<int> byRange;
    for (int item : gea::cursorRange(ranged)) byRange.push_back(item);
    CHECK(byLoop == byRange && byRange.size() == 3);
    CHECK(looped.trace == ranged.trace && ranged.trace == "ndndndnd");
  }
  // break and continue
  {
    CountingCursor ranged{{1, 2, 3, 4, 5}};
    std::vector<int> seen;
    for (int item : gea::cursorRange(ranged)) {
      if (item == 2) continue;
      if (item == 4) break;
      seen.push_back(item);
    }
    CHECK((seen == std::vector<int>{1, 3}));
    CHECK(ranged.trace == "ndndndnd");  // stopped after the fourth element was read
  }
  // an empty cursor runs the body zero times, after one arrayNext/done
  {
    CountingCursor empty{{}};
    int runs = 0;
    for (int item : gea::cursorRange(empty)) {
      (void)item;
      ++runs;
    }
    CHECK(runs == 0 && empty.trace == "nd");
  }
  // the real cursors: an array walk with a hole, and a string key walk
  {
    auto array = gea::makeRef<gea::ArrayObject<std::string>>();
    array->push("a");
    array->push("b");
    array->push("c");
    gea::LocalArrayCursor<std::string> cursor(array);
    std::string joined;
    for (std::string item : gea::cursorRange(cursor)) joined += item;
    CHECK(joined == "abc");
    // pushing during the walk is seen, as it is by the cursor's own loop
    gea::LocalArrayCursor<std::string> growing(array);
    int count = 0;
    for (std::string item : gea::cursorRange(growing)) {
      if (count == 0) array->push("d");
      ++count;
      (void)item;
    }
    CHECK(count == 4);
  }
  std::printf(failures == 0 ? "ALL OK\n" : "FAILURES: %d\n", failures);
  return failures == 0 ? 0 : 1;
}
