import { walkStepOf } from "../state.js";
import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

/**
 * Three questions that can only be answered by comparing a client with everybody else.
 *
 * All of them read {@link SiteProfile}, all of them are silent unless `site` is
 * configured, and all of them are silent again until it has warmed up. That last point
 * is the one worth repeating: during warmup every path is rare because nothing has been
 * seen, so a baseline consulted early does not merely fail, it fails *confidently*.
 *
 * None of them exceeds `moderate`. A baseline is a claim about what is normal for a
 * site, and it is wrong in exactly the circumstances a site is most unusual — the day of
 * a redesign, the hour a campaign lands, the migration that leaves half the URLs
 * missing. That is not a reason to skip the comparison; it is a reason never to let one
 * close a door on its own.
 */

export interface DistributedWalkOptions {
  /** Distinct actors on one shape before it is worth reporting. Default 8. */
  minActors?: number;
  /** Distinct ids that must have been covered. Default 150. */
  minIds?: number;
  /** Fraction of the id range that must actually have been requested. Default 0.6. */
  minCoverage?: number;
  /** Highest visits-per-id that still reads as enumeration rather than reading. Default 1.3. */
  maxRevisitRatio?: number;
  /**
   * Lowest visits-per-id that still reads as enumeration. Default 0.7.
   *
   * Guards the estimate rather than the traffic — see the note on coarsening below.
   */
  minRevisitRatio?: number;
}

/**
 * An enumeration split across many clients so that no single one looks like one.
 *
 * This is the threat every per-actor threshold misses by construction. Take a wordlist,
 * or an id range, and divide it between five hundred addresses at one request a minute
 * each: every actor is unremarkable, `id-enumeration` never fires for anybody, and the
 * range is still walked end to end. The only place it is visible is in the union.
 *
 * **What separates it from a popular site.** Many clients requesting numbered pages is
 * ordinary — that is what a catalogue is. Two things are not. Enumeration *covers* a
 * contiguous range rather than sampling the popular parts of it, and it visits each id
 * about once, because there is no reason to fetch the same record twice. Real readers
 * are the opposite on both counts: they cluster on a few popular ids and return to them.
 * So coverage and the revisit ratio are both required, and either one alone would report
 * an ordinary shop.
 *
 * **Why this is `moderate` and why it stays there.** The evidence is about the *shape*,
 * and it is attached to a client that contributed to it — which is the closest this
 * library comes to holding one client responsible for what others did. It is defensible
 * only because the actor is genuinely part of the pattern being described, and only at a
 * weight that cannot deny anybody by itself. A partner integration syncing a catalogue
 * from a pool of workers produces this exactly, and is welcome traffic.
 */
export function distributedWalkDetector(options: DistributedWalkOptions = {}): Detector {
  const minActors = options.minActors ?? 8;
  const minIds = options.minIds ?? 150;
  const minCoverage = options.minCoverage ?? 0.6;
  const maxRevisitRatio = options.maxRevisitRatio ?? 1.3;
  const minRevisitRatio = options.minRevisitRatio ?? 0.7;

  return {
    id: "distributed-walk",
    description: "Reports a numeric range being walked across many clients, none of which walks enough of it alone",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      if (ctx.site === undefined || !ctx.site.warm) return undefined;
      // Only for a client that is part of the pattern. Reporting a shape at somebody who
      // merely visited the same page would be an accusation about other people.
      const step = walkStepOf(ctx.facts.path);
      if (step === undefined) return undefined;

      const spread = ctx.site.spreadOf(step.template);
      if (spread === undefined) return undefined;
      if (spread.actors < minActors || spread.ids < minIds) return undefined;
      if (spread.coverage < minCoverage) return undefined;
      // Against the estimated ids rather than the buckets. Once the bitmap has coarsened
      // a bucket stands for `scale` ids, so comparing visits with buckets would read a
      // perfectly clean enumeration of twenty thousand records as thirty-two visits
      // apiece — and the larger the walk, the more certainly it would be missed.
      //
      // The ratio is bounded on *both* sides, and the lower bound is what makes this
      // usable on a real site. An enumeration visits each id about once: not much more,
      // because there is no reason to fetch a record twice, and not much less, because it
      // is walking rather than sampling. Only the upper bound existed at first, and on a
      // shop whose catalogue runs to six figures the bitmap coarsens until a bucket
      // stands for hundreds of ids — at which point ordinary browsing touches nearly
      // every bucket, coverage reads 1.0, and `touched * scale` extrapolates to hundreds
      // of thousands of ids that nobody requested. Measured: sixty long-tail shoppers,
      // every one of them reported. Requiring the visits to actually account for the ids
      // claimed is what rejects an estimate that has run away from the evidence.
      const revisits = spread.visits / spread.ids;
      if (revisits > maxRevisitRatio || revisits < minRevisitRatio) return undefined;

      return {
        detector: "distributed-walk",
        summary:
          `${spread.actors} clients between them have requested ${spread.ids} ids under ${step.template}, ` +
          `covering ${(spread.coverage * 100).toFixed(0)}% of the range and almost none of them twice`,
        direction: "bot",
        certainty: "moderate",
        botClass: "scraper",
      };
    },
  };
}

export interface PathNoveltyOptions {
  /** Requests before the ratio means anything. Default 30. */
  minRequests?: number;
  /** Share of an actor's requests that must be for paths nobody else asked for. Default 0.95. */
  minNovelShare?: number;
}

/**
 * A client asking for things this site has never been asked for.
 *
 * A wordlist is a list of paths that exist on *some* sites. On yours, most of them do
 * not exist and nobody has ever requested them — which makes "nobody else has ever asked
 * for this" a self-maintaining wordlist detector that needs no wordlist. It catches the
 * scanner whose list is newer than `EXPLOIT_PATHS`, and it costs nothing to keep current.
 *
 * **The bar is deliberately close to 1.** Plenty of ordinary traffic requests novel
 * paths: a search page with the query in the path, a CMS with per-article slugs, a
 * long-tail catalogue where most items are viewed once a month. What none of those do is
 * request *only* novel paths for thirty requests in a row. The share is the signal, not
 * the count.
 *
 * **What it cannot see.** The profile is per process and its table evicts, so a path the
 * site serves rarely can read as novel after it ages out. That direction produces false
 * positives rather than misses, which is why this is capped at `moderate` and why the
 * share is set where it is.
 */
export function pathNoveltyDetector(options: PathNoveltyOptions = {}): Detector {
  const minRequests = options.minRequests ?? 30;
  const minNovelShare = options.minNovelShare ?? 0.95;

  return {
    id: "path-novelty",
    description: "Reports a client whose requests are almost all for paths this site has never been asked for",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      if (ctx.site === undefined || !ctx.site.warm) return undefined;
      const total = ctx.state.total;
      if (total < minRequests) return undefined;
      const share = ctx.state.novelPathCount / total;
      if (share < minNovelShare) return undefined;

      return {
        detector: "path-novelty",
        summary: `${(share * 100).toFixed(0)}% of this client's ${total} requests were for paths no other client has ever asked this site for`,
        direction: "bot",
        certainty: "moderate",
        botClass: "scanner",
        // The same cause `probe-signature` names when a path is on a list it ships: this
        // client is walking a list rather than reading a site.
        family: "wordlist-probe",
      };
    },
  };
}

export interface MissBaselineOptions {
  /** Answered requests from this actor before the comparison means anything. Default 20. */
  minResponses?: number;
  /** How many times the site's own miss rate this actor must exceed. Default 5. */
  minRatio?: number;
  /** Below this the actor's own miss rate is unremarkable whatever the site's is. Default 0.5. */
  floor?: number;
}

/**
 * A client missing far more than this site's visitors normally do.
 *
 * `probe-volume` asks whether an actor's requests are mostly misses, against a fixed
 * threshold. That threshold is wrong on both kinds of site: on one mid-migration, where
 * half of all traffic 404s, it reports everybody; on a tidy one where a miss is genuinely
 * rare, a client missing a third of the time is remarkable and it says nothing.
 *
 * Comparing against the site's own rate fixes both, and is why this reports the ratio
 * rather than the number. It needs the application to report outcomes, which every
 * bundled adapter does.
 */
export function missBaselineDetector(options: MissBaselineOptions = {}): Detector {
  const minResponses = options.minResponses ?? 20;
  const minRatio = options.minRatio ?? 5;
  const floor = options.floor ?? 0.5;

  return {
    id: "miss-baseline",
    description: "Compares how often a client is answered \"not found\" with how often this site answers that at all",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      const siteRate = ctx.site?.missRate;
      if (siteRate === undefined) return undefined;
      const { responses, misses } = ctx.state;
      if (responses < minResponses) return undefined;

      const rate = misses / responses;
      if (rate < floor) return undefined;
      // A site that never misses makes every ratio infinite, so the floor above carries
      // the comparison on its own there.
      if (siteRate > 0 && rate / siteRate < minRatio) return undefined;

      return {
        detector: "miss-baseline",
        summary:
          siteRate > 0
            ? `${(rate * 100).toFixed(0)}% of this client's requests were answered "not found", against ${(siteRate * 100).toFixed(1)}% across the site`
            : `${(rate * 100).toFixed(0)}% of this client's requests were answered "not found", on a site that otherwise never answers that`,
        direction: "bot",
        certainty: "moderate",
        botClass: "scanner",
        // `probe-volume` reads the same misses against a fixed threshold. Two readings
        // of one cause, so the stronger stands and they do not sum.
        family: "misses",
      };
    },
  };
}

export interface PathCampaignOptions {
  /** Distinct clients on a newly-appeared path before it is worth reporting. Default 12. */
  minClients?: number;
  /** Share of the answers to it that must be misses. Default 0.9. */
  minMissShare?: number;
  /** Answers needed before that share means anything. Default 10. */
  minAnswered?: number;
}

/**
 * A path this site has never served, suddenly being asked for by everybody.
 *
 * This is what a freshly published vulnerability looks like from inside a site: a URL
 * nobody had ever requested is requested by hundreds of unrelated clients within an hour
 * of the disclosure, because they are all running the same new list. It is the exact
 * inverse of `path-novelty`, which reads one client asking for many unknown paths, and
 * it catches the traffic that detector misses — a client running one probe and moving on
 * looks like nothing at all on its own.
 *
 * **Why the miss rate is required, and not optional.** Many clients arriving at once on
 * a brand-new URL is also precisely what a successful launch looks like: a page goes up,
 * a newsletter goes out, and thousands of people request a path that did not exist
 * yesterday. Counting clients alone would report every marketing campaign a site ever
 * runs. What separates them is what the application answered — a launch returns a page,
 * a probe returns nothing — so the miss share is what makes this a signal rather than a
 * traffic alarm, and the detector is silent without outcomes being reported.
 *
 * **Why it is still `moderate`.** The client this is attached to did request the path,
 * so it is describing something that client did; but *most* of the evidence is about
 * everybody else's behaviour, and a client that followed a bad link from somewhere is
 * indistinguishable here from one running the list. That is a real limit, not a
 * conservative gesture.
 */
export function pathCampaignDetector(options: PathCampaignOptions = {}): Detector {
  const minClients = options.minClients ?? 12;
  const minMissShare = options.minMissShare ?? 0.9;
  const minAnswered = options.minAnswered ?? 10;

  return {
    id: "path-campaign",
    description: "Reports a path this site never served that many unrelated clients have suddenly begun requesting",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      const surge = ctx.site?.surgeOf(ctx.facts.path);
      if (surge === undefined) return undefined;
      if (surge.clients < minClients || surge.answered < minAnswered) return undefined;
      if (surge.misses / surge.answered < minMissShare) return undefined;

      return {
        detector: "path-campaign",
        summary:
          `${surge.clients} unrelated clients have requested ${ctx.facts.path} since it first appeared ` +
          `${Math.round(surge.ageMs / 60_000)} minutes ago, and the site has answered "not found" to almost all of them`,
        direction: "bot",
        certainty: "moderate",
        botClass: "scanner",
      };
    },
  };
}
