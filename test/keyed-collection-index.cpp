#include "gea_runtime.h"
#include <cmath>
#include <cstdio>
#include <random>
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

// Reference: insertion-ordered vector with a linear scan, the behaviour before the index existed.
template <typename K, typename V>
struct RefMap {
  std::vector<std::pair<K, V>> e;
  void set(K k, V v) {
    gea::canonicalizeKeyInPlace(k);
    for (auto& p : e)
      if (gea::sameValueZero(p.first, k)) {
        p.second = v;
        return;
      }
    e.emplace_back(k, v);
  }
  bool has(const K& k) const {
    for (auto& p : e)
      if (gea::sameValueZero(p.first, k)) return true;
    return false;
  }
  bool remove(const K& k) {
    for (size_t i = 0; i < e.size(); ++i)
      if (gea::sameValueZero(e[i].first, k)) {
        e.erase(e.begin() + i);
        return true;
      }
    return false;
  }
};

template <typename K, typename V>
static void same(const gea::Map<K, V>& m, const RefMap<K, V>& r) {
  CHECK(m.entries().size() == r.e.size());
  for (size_t i = 0; i < r.e.size() && i < m.entries().size(); ++i) {
    CHECK(gea::sameValueZero(m.entries()[i].first, r.e[i].first));
    CHECK(m.entries()[i].second == r.e[i].second);
  }
}

int main() {
  std::mt19937 rng(7);
  // string keys, many entries, random set/remove/get, order checked against the reference
  {
    gea::Map<std::string, int> m;
    RefMap<std::string, int> r;
    for (int step = 0; step < 20000; ++step) {
      std::string key = "k" + std::to_string(rng() % 300);
      int op = rng() % 4;
      if (op < 2) {
        m.set(key, step);
        r.set(key, step);
      } else if (op == 2) {
        CHECK(m.remove(key) == r.remove(key));
      } else {
        CHECK(m.has(key) == r.has(key));
        auto got = m.get(key);
        CHECK(got.has_value() == r.has(key));
      }
      CHECK(m.size() == static_cast<double>(r.e.size()));
      if (step % 1000 == 999) {
        // walk by cursor, which is how a Map Iterator reads, and compare with the reference order
        std::uint64_t serial = 0;
        size_t at = 0;
        while (const auto* entry = m.entryAfter(serial)) {
          CHECK(at < r.e.size() && entry->first == r.e[at].first && entry->second == r.e[at].second);
          ++at;
        }
        CHECK(at == r.e.size());
      }
    }
    same(m, r);
    m.clear();
    CHECK(m.size() == 0);
    for (int i = 0; i < 40; ++i) m.set("a" + std::to_string(i), i);
    CHECK(m.has("a39") && m.size() == 40);
  }
  // delete-heavy: empty a large map through a cursor, re-add some keys, and read it back dense
  {
    gea::Map<std::string, int> m;
    for (int i = 0; i < 500; ++i) m.set("m" + std::to_string(i), i);
    std::uint64_t serial = 0;
    int visited = 0;
    while (const auto* entry = m.entryAfter(serial)) {
      std::string key = entry->first;  // copy out before stepping, as a cursor does
      CHECK(m.remove(key));
      ++visited;
    }
    CHECK(visited == 500 && m.size() == 0 && m.entries().empty());
    for (int i = 0; i < 100; ++i) m.set("m" + std::to_string(i * 3), i);
    CHECK(m.size() == 100 && m.entries().size() == 100 && m.entries()[0].first == "m0" && m.entries()[99].first == "m297");
    CHECK(!m.has("m1") && m.has("m3"));
    gea::Set<double> s;
    for (int i = 0; i < 200; ++i) s.add(static_cast<double>(i));
    for (int i = 0; i < 200; i += 2) CHECK(s.remove(static_cast<double>(i)));
    CHECK(s.size() == 100 && s.items().size() == 100 && s.items()[0] == 1.0 && s.items()[99] == 199.0);
    s.add(0.0);
    CHECK(s.size() == 101 && s.has(0.0) && s.items().back() == 0.0);
  }
  // number keys: -0 and 0 are one key, NaN equals NaN, order kept
  {
    gea::Map<double, int> m;
    RefMap<double, int> r;
    for (int i = 0; i < 100; ++i) {
      m.set(static_cast<double>(i), i);
      r.set(static_cast<double>(i), i);
    }
    m.set(-0.0, 1000);
    r.set(-0.0, 1000);
    m.set(std::nan(""), 7);
    r.set(std::nan(""), 7);
    m.set(std::nan(""), 8);
    r.set(std::nan(""), 8);
    CHECK(m.has(0.0) && m.has(-0.0) && m.has(std::nan("")));
    CHECK(m.get(0.0).has_value() && *m.get(0.0) == 1000);
    CHECK(m.size() == 101);
    CHECK(!std::signbit(m.entries()[0].first));
    same(m, r);
  }
  // set: iteration cursor survives deletion (entryAfter on a Set via itemAfter)
  {
    gea::Set<std::string> s;
    for (int i = 0; i < 64; ++i) s.add("s" + std::to_string(i));
    std::uint64_t serial = 0;
    int seen = 0;
    while (const std::string* item = s.itemAfter(serial)) {
      CHECK(s.remove(*item));
      ++seen;
    }
    CHECK(seen == 64 && s.size() == 0);
    for (int i = 0; i < 50; ++i) s.add("t" + std::to_string(i % 20));
    CHECK(s.size() == 20 && s.has("t19") && !s.has("t20"));
    CHECK(s.items()[0] == "t0" && s.items()[19] == "t19");
  }
  // Ref keys: identity, and an optional-keyed map
  {
    auto a = gea::makeRef<int>(1);
    auto b = gea::makeRef<int>(1);
    gea::Set<gea::Ref<int>> s;
    std::vector<gea::Ref<int>> keep;
    for (int i = 0; i < 40; ++i) {
      keep.push_back(gea::makeRef<int>(i));
      s.add(keep.back());
    }
    s.add(a);
    CHECK(s.has(a) && !s.has(b) && s.size() == 41);
    CHECK(s.has(keep[17]) && s.remove(keep[17]) && !s.has(keep[17]) && s.size() == 40);
    gea::Map<gea::Optional<std::string>, int> m;
    for (int i = 0; i < 30; ++i) m.set(gea::Optional<std::string>("o" + std::to_string(i)), i);
    m.set(gea::Optional<std::string>(), 99);
    CHECK(m.has(gea::Optional<std::string>()) && *m.get(gea::Optional<std::string>()) == 99 && m.size() == 31);
  }
  // integer keys and bool keys
  {
    gea::Map<long long, int> m;
    for (long long i = 0; i < 100; ++i) m.set(i * 3, static_cast<int>(i));
    CHECK(m.has(297) && !m.has(298) && m.remove(297) && !m.has(297));
  }
  std::printf(failures == 0 ? "ALL OK\n" : "FAILURES: %d\n", failures);
  return failures == 0 ? 0 : 1;
}
