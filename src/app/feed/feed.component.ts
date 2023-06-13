import {
  AfterViewChecked,
  ChangeDetectorRef,
  Component,
  Input,
  OnDestroy,
  OnInit,
  QueryList,
  ViewChildren,
} from "@angular/core";
import { Title } from "@angular/platform-browser";
import { ActivatedRoute, Router } from "@angular/router";
import * as _ from "lodash";
import { BsModalService } from "ngx-bootstrap/modal";
import PullToRefresh from "pulltorefreshjs";
import { Subscription } from "rxjs";
import { finalize, first, tap } from "rxjs/operators";
import { TrackingService } from "src/app/tracking.service";
import { WelcomeModalComponent } from "src/app/welcome-modal/welcome-modal.component";
import { environment } from "src/environments/environment";
import { BackendApiService } from "../backend-api.service";
import { GlobalVarsService } from "../global-vars.service";
import { FeedPostComponent } from "./feed-post/feed-post.component";

@Component({
  selector: "feed",
  templateUrl: "./feed.component.html",
  styleUrls: ["./feed.component.sass"],
})
export class FeedComponent implements OnInit, OnDestroy, AfterViewChecked {
  static HOT_TAB = "Hot";
  static TAG_TAB = "Tag";
  static GLOBAL_TAB = "New";
  static FOLLOWING_TAB = "Following";
  static SHOWCASE_TAB = "NFT Gallery";
  static NEW_TABS = [];
  static NUM_TO_FETCH = 50;
  static MIN_FOLLOWING_TO_SHOW_FOLLOW_FEED_BY_DEFAULT = 10;
  static PULL_TO_REFRESH_MARKER_ID = "pull-to-refresh-marker";

  @Input() activeTab: string;
  @Input() isMobile = false;

  @ViewChildren("feedPost") feedPosts: QueryList<FeedPostComponent>;

  loggedInUserSubscription: Subscription;
  followChangeSubscription: Subscription;
  FeedComponent = FeedComponent;
  switchingTabs = false;
  deadTabs = new Set([this.FeedComponent.SHOWCASE_TAB]);

  nextNFTShowcaseTime;

  hotFeedPostHashes = [];
  tagFeedPostHashes = [];

  followedPublicKeyToProfileEntry = {};
  followedCount = 0;
  followBannerThreshold = 10;

  // We load the first batch of follow feed posts on page load and whenever the user follows someone
  loadingFirstBatchOfFollowFeedPosts = false;

  // We load the first batch of global feed posts on page load
  loadingFirstBatchOfGlobalFeedPosts = false;

  // We load the first batch of follow feed posts on page load and whenever the user follows someone
  loadingFirstBatchOfHotFeedPosts = false;
  loadingFirstBatchOfTagFeedPosts = false;

  // We load the user's following on page load. This boolean tracks whether we're currently loading
  // or whether we've finished.
  isLoadingFollowingOnPageLoad;

  globalVars: GlobalVarsService;
  serverHasMoreFollowFeedPosts = true;
  serverHasMoreGlobalFeedPosts = true;
  loadingMoreFollowFeedPosts = false;
  loadingMoreGlobalFeedPosts = false;
  loadingMoreHotFeedPosts = false;
  loadingMoreTagFeedPosts = false;

  pullToRefreshHandler;

  userReferral = null;

  pauseVideos = false;

  referralExpiration = new Date("2021-10-25T22:00:00.000Z");

  // This is [Following, Global, Market] if the user is following anybody. Otherwise,
  // it's [Global, Following, Market].
  //
  // TODO: if you switch between accounts while viewing the feed, we don't recompute this.
  // So if user1 is following folks, and we switch to user2 who isn't following anyone,
  // the empty follow feed will be the first tab (which is incorrect) and
  feedTabs = [];
  newTabs = FeedComponent.NEW_TABS;
  tag: string;
  expandTagSelector: boolean = false;

  constructor(
    private appData: GlobalVarsService,
    private router: Router,
    private route: ActivatedRoute,
    private cdr: ChangeDetectorRef,
    private backendApi: BackendApiService,
    private titleService: Title,
    private modalService: BsModalService,
    private tracking: TrackingService
  ) {
    this.globalVars = appData;

    this.route.queryParams.subscribe((queryParams) => {
      if (queryParams.feedTab) {
        if (queryParams.feedTab === "Showcase") {
          this.activeTab = FeedComponent.SHOWCASE_TAB;
        } else {
          this.activeTab = queryParams.feedTab;
          if (this.activeTab === "Hot 🔥") {
            this.activeTab = FeedComponent.HOT_TAB;
          }
        }
      } else {
        // A default activeTab will be set after we load the follow feed (based on whether
        // the user is following anybody)
        this.activeTab = null;
      }
    });

    this.route.params.subscribe((params) => {
      if (params.tag) {
        this.tag = params.tag;
        this.activeTab = FeedComponent.TAG_TAB;
        // Request the tag feed (so we have it ready for display if needed)
        this.loadingFirstBatchOfTagFeedPosts = true;
        this._loadTagFeedPosts(true);
      }
    });

    if (this.activeTab === FeedComponent.TAG_TAB && (!this.tag || this.tag === "")) {
      this.activeTab = FeedComponent.HOT_TAB;
    }

    // Reload the follow feed any time the user follows / unfollows somebody
    this.followChangeSubscription = this.appData.followChangeObservable.subscribe((followChangeObservableResult) => {
      this._reloadFollowFeed();
    });

    this.loggedInUserSubscription = this.appData.loggedInUserObservable.subscribe((loggedInUserObservableResult) => {
      // Reload the follow feed if the logged in user changed
      if (!loggedInUserObservableResult.isSameUserAsBefore && !this.globalVars.userSigningUp) {
        // Set activeTab to null so that a sensible default tab is selected
        this.activeTab = null;
        this._initializeFeeds();
      }
    });
  }

  ngOnInit() {
    this._initializeFeeds();
    this.titleService.setTitle(`Feed - ${environment.node.name}`);
  }

  ngAfterViewChecked() {
    // if the marker was removed for some reason,
    // then clear out the handler to allow it to be recreated later
    if (!document.getElementById(this.getPullToRefreshMarkerId())) {
      this.pullToRefreshHandler?.destroy();
      this.pullToRefreshHandler = undefined;
    } else if (!this.pullToRefreshHandler) {
      // initialize the handler only once when the
      // marker is first created
      this.pullToRefreshHandler = PullToRefresh.init({
        mainElement: `#${this.getPullToRefreshMarkerId()}`,
        onRefresh: () => {
          const globalPostsPromise = this._loadPosts(true);
          const followPostsPromise = this._loadFollowFeedPosts(true);
          const hotPostsPromise = this._loadHotFeedPosts(true);
          return this.activeTab === FeedComponent.FOLLOWING_TAB ? followPostsPromise : globalPostsPromise;
        },
      });
    }
  }

  ngOnDestroy() {
    this.pullToRefreshHandler?.destroy();
    this.loggedInUserSubscription.unsubscribe();
  }

  _reloadFollowFeed() {
    // Reload the follow feed from scratch
    this.globalVars.followFeedPosts = [];
    this.loadingFirstBatchOfFollowFeedPosts = true;
    return this._loadFollowFeedPosts();
  }

  _initializeFeeds() {
    this.feedTabs = [FeedComponent.FOLLOWING_TAB, FeedComponent.HOT_TAB];
    if (this.globalVars.loggedInUser) {
      this.feedTabs.push(FeedComponent.GLOBAL_TAB);
    }
    if (this.globalVars.postsToShow.length === 0) {
      // Get some posts to show the user.
      this.loadingFirstBatchOfGlobalFeedPosts = true;
      this._loadPosts();
    } else {
      // If we already have posts to show, delay rendering the posts for a hot second so nav is fast.
      // this._onTabSwitch()
    }

    const feedPromises = [];
    // Request the hot feed (so we have it ready for display if needed)
    if (this.globalVars.hotFeedPosts.length === 0) {
      this.loadingFirstBatchOfHotFeedPosts = true;
      this._loadHotFeedPosts();
    }

    // Request the follow feed (so we have it ready for display if needed)
    if (this.globalVars.followFeedPosts.length === 0) {
      this.loadingFirstBatchOfFollowFeedPosts = true;
      this._reloadFollowFeed();
    }

    // The activeTab is set after we load the following based on whether the user is
    // already following anybody
    if (this.appData.loggedInUser) {
      this._loadFollowing();
    } else {
      // If there's no user, consider the following to be loaded (it's empty)
      this._afterLoadingFollowingOnPageLoad();
    }
  }

  getPullToRefreshMarkerId() {
    return FeedComponent.PULL_TO_REFRESH_MARKER_ID;
  }

  prependPostToFeed(postEntryResponse) {
    FeedComponent.prependPostToFeed(this.postsToShow(), postEntryResponse);
  }

  onPostHidden(postEntryResponse) {
    const parentPostIndex = FeedComponent.findParentPostIndex(this.postsToShow(), postEntryResponse);
    const parentPost = this.postsToShow()[parentPostIndex];

    FeedComponent.onPostHidden(
      this.postsToShow(),
      postEntryResponse,
      parentPost,
      null /*grandparentPost... don't worry about them on the feed*/
    );

    // Remove / re-add the parentPost from postsToShow, to force
    // angular to re-render now that we've updated the comment count
    this.postsToShow()[parentPostIndex] = _.cloneDeep(parentPost);
  }

  userBlocked() {
    this.cdr.detectChanges();
  }

  pauseAllVideos(isPaused) {
    this.pauseVideos = isPaused;
  }

  appendCommentAfterParentPost(postEntryResponse) {
    FeedComponent.appendCommentAfterParentPost(this.postsToShow(), postEntryResponse);
  }

  hideFollowLink() {
    return this.activeTab === FeedComponent.FOLLOWING_TAB;
  }

  postsToShow() {
    if (this.activeTab === FeedComponent.FOLLOWING_TAB) {
      // No need to delay on the Following tab. It handles the "slow switching" issue itself.
      return this.globalVars.followFeedPosts;
    } else if (this.activeTab === FeedComponent.HOT_TAB) {
      return this.globalVars.hotFeedPosts;
    } else if (this.activeTab === FeedComponent.TAG_TAB) {
      return this.globalVars.tagFeedPosts;
    } else {
      return this.globalVars.postsToShow;
    }
  }

  toggleTagInput(expanded: boolean) {
    if (!expanded && (!this.tag || this.tag.length === 0)) {
      this.expandTagSelector = expanded;
    } else if (expanded) {
      this.expandTagSelector = expanded;
    }
  }

  updateTag() {
    this.tracking.log("hashtag-input : change", { hashtag: this.tag });
    this.activeTab = FeedComponent.TAG_TAB;
    this.router.navigate(["/" + this.globalVars.RouteNames.BROWSE + "/" + this.globalVars.RouteNames.TAG, this.tag], {
      queryParamsHandling: "merge",
    });
    this.loadingFirstBatchOfTagFeedPosts = true;
    this._loadTagFeedPosts(true);
  }

  activeTabReadyForDisplay() {
    // If we don't have the following yet, we don't even know which tab to display
    if (this.isLoadingFollowingOnPageLoad) {
      return false;
    }

    if (this.activeTab === FeedComponent.FOLLOWING_TAB) {
      // No need to delay on the Following tab. It handles the "slow switching" issue itself.
      return this.loadingMoreFollowFeedPosts;
    } else if (this.activeTab === FeedComponent.HOT_TAB) {
      return this.loadingMoreHotFeedPosts;
    } else {
      return this.loadingMoreGlobalFeedPosts;
    }
  }

  showLoadingSpinner() {
    return (
      this.activeTab !== FeedComponent.SHOWCASE_TAB && (this.loadingFirstBatchOfActiveTabPosts() || this.switchingTabs)
    );
  }

  // controls whether we show the loading spinner
  loadingFirstBatchOfActiveTabPosts() {
    if (this.activeTab === FeedComponent.FOLLOWING_TAB) {
      return this.loadingFirstBatchOfFollowFeedPosts;
    } else if (this.activeTab === FeedComponent.TAG_TAB) {
      return this.loadingFirstBatchOfTagFeedPosts;
    } else {
      return this.loadingFirstBatchOfGlobalFeedPosts;
    }
  }

  showGlobalOrFollowingOrHotPosts() {
    return (
      this.postsToShow().length > 0 &&
      (this.activeTab === FeedComponent.GLOBAL_TAB ||
        this.activeTab === FeedComponent.FOLLOWING_TAB ||
        this.activeTab === FeedComponent.HOT_TAB ||
        this.activeTab === FeedComponent.TAG_TAB)
    );
  }

  showNoPostsFound() {
    // activeTab == FeedComponent.GLOBAL_TAB && globalVars.postsToShow.length === 0 && !loadingPosts
    return (
      this.postsToShow().length === 0 &&
      (this.activeTab === FeedComponent.GLOBAL_TAB ||
        this.activeTab === FeedComponent.FOLLOWING_TAB ||
        this.activeTab === FeedComponent.TAG_TAB) &&
      !this.loadingFirstBatchOfActiveTabPosts()
    );
  }

  loadMorePosts() {
    if (!this.globalVars.loggedInUser) {
      this.modalService.show(WelcomeModalComponent, { initialState: { triggerAction: "load-more-posts" } });
      return;
    }

    if (this.activeTab === FeedComponent.FOLLOWING_TAB) {
      this._loadFollowFeedPosts();
    } else if (this.activeTab === FeedComponent.HOT_TAB) {
      this._loadHotFeedPosts();
    } else if (this.activeTab === FeedComponent.TAG_TAB) {
      this._loadTagFeedPosts();
    } else {
      this._loadPosts();
    }
  }

  showMoreButton() {
    if (this.loadingFirstBatchOfActiveTabPosts()) {
      return false;
    }

    if (this.activeTab === FeedComponent.FOLLOWING_TAB) {
      return this.serverHasMoreFollowFeedPosts;
    } else {
      return this.serverHasMoreGlobalFeedPosts;
    }
  }

  _onTabSwitch() {
    // Delay rendering the posts for a hot second so nav is fast.
    this.switchingTabs = true;
    setTimeout(() => {
      this.switchingTabs = false;
    }, 0);
  }

  _loadPosts(reload: boolean = false) {
    this.loadingMoreGlobalFeedPosts = true;

    // Get the reader's public key for the request.
    let readerPubKey = "";
    if (this.globalVars.loggedInUser) {
      readerPubKey = this.globalVars.loggedInUser?.PublicKeyBase58Check;
    }

    // Get the last post hash in case this is a "load more" request.
    let lastPostHash = "";
    if (this.globalVars.postsToShow.length > 0 && !reload) {
      lastPostHash = this.globalVars.postsToShow[this.globalVars.postsToShow.length - 1].PostHashHex;
    }

    return this.backendApi
      .GetPostsStateless(
        lastPostHash /*PostHash*/,
        readerPubKey /*ReaderPublicKeyBase58Check*/,
        "", // Blank orderBy so we don't sort twice
        parseInt(this.globalVars.filterType) /*StartTstampSecs*/,
        "",
        FeedComponent.NUM_TO_FETCH /*NumToFetch*/,
        false /*FetchSubcomments*/,
        false /*GetPostsForFollowFeed*/,
        false /*GetPostsForGlobalWhitelist*/,
        false,
        false /*MediaRequired*/,
        0,
        this.globalVars.showAdminTools() /*AddGlobalFeedBool*/
      )
      .pipe(
        tap(
          (res) => {
            if (lastPostHash !== "") {
              this.globalVars.postsToShow = this.globalVars.postsToShow.concat(
                _.filter(res.PostsFound, { IsPinned: false })
              );
            } else {
              this.globalVars.postsToShow = _.filter(res.PostsFound, { IsPinned: false });
            }
            if (res.PostsFound.length < FeedComponent.NUM_TO_FETCH - 1) {
              // I'm not sure what the expected behavior is for the global feed. It may sometimes
              // return less than NUM_TO_FETCH while there are still posts available (e.g. if posts
              // are deleted. I'm not sure so just commenting out for now.
              // We'll move to infinite scroll soon, so not sure this is worth fixing rn.
              // this.serverHasMoreGlobalFeedPosts = true
            }
          },
          (err) => {
            console.error(err);
            this.globalVars._alertError("Error loading posts: " + this.backendApi.stringifyError(err));
          }
        ),
        finalize(() => {
          this.loadingFirstBatchOfGlobalFeedPosts = false;
          this.loadingMoreGlobalFeedPosts = false;
        }),
        first()
      )
      .toPromise();
  }

  _loadFollowing() {
    this.isLoadingFollowingOnPageLoad = true;
    this.backendApi
      .GetFollows(
        "" /* username */,
        this.appData.loggedInUser.PublicKeyBase58Check,
        false /* getEntriesFollowingPublicKey */
      )
      .subscribe(
        (response) => {
          this.followedPublicKeyToProfileEntry = response.PublicKeyToProfileEntry;
          this.followedCount = this.followedPublicKeyToProfileEntry
            ? Object.keys(this.followedPublicKeyToProfileEntry)?.length
            : 0;
        },
        (error) => {}
      )
      .add(() => {
        this._afterLoadingFollowingOnPageLoad();
      });
  }

  _loadFollowFeedPosts(reload: boolean = false) {
    this.loadingMoreFollowFeedPosts = true;

    // Get the reader's public key for the request.
    let readerPubKey = "";
    if (this.globalVars.loggedInUser) {
      readerPubKey = this.globalVars.loggedInUser?.PublicKeyBase58Check;
    }

    // Get the last post hash in case this is a "load more" request.
    let lastPostHash = "";
    if (this.globalVars.followFeedPosts.length > 0 && !reload) {
      lastPostHash = this.globalVars.followFeedPosts[this.globalVars.followFeedPosts.length - 1].PostHashHex;
    }
    return this.backendApi
      .GetPostsStateless(
        lastPostHash /*PostHash*/,
        readerPubKey /*ReaderPublicKeyBase58Check*/,
        "newest" /*OrderBy*/,
        parseInt(this.globalVars.filterType) /*StartTstampSecs*/,
        "",
        FeedComponent.NUM_TO_FETCH /*NumToFetch*/,
        false /*FetchSubcomments*/,
        true /*GetPostsForFollowFeed*/,
        false /*GetPostsForGlobalWhitelist*/,
        false,
        false /*MediaRequired*/,
        0,
        this.globalVars.showAdminTools() /*AddGlobalFeedBool*/
      )
      .pipe(
        tap(
          (res) => {
            if (lastPostHash !== "") {
              this.globalVars.followFeedPosts = this.globalVars.followFeedPosts.concat(res.PostsFound);
            } else {
              this.globalVars.followFeedPosts = res.PostsFound;
            }
            if (res.PostsFound.length < FeedComponent.NUM_TO_FETCH) {
              this.serverHasMoreFollowFeedPosts = false;
              // Note: the server may be out of posts even if res.PostsFond == NUM_TO_FETCH.
              // This can happen if the server returns the last NUM_TO_FETCH posts exactly.
              // In that case, the user will click the load more button one more time, and then
              // the server will return 0. Obviously this isn't great behavior, but hopefully
              // we'll swap out the load more button for infinite scroll soon anyway.
            }
            this.loadingFirstBatchOfFollowFeedPosts = false;
            this.loadingMoreFollowFeedPosts = false;
          },
          (err) => {
            console.error(err);
            this.globalVars._alertError("Error loading posts: " + this.backendApi.stringifyError(err));
          }
        ),
        finalize(() => {
          this.loadingFirstBatchOfFollowFeedPosts = false;
          this.loadingMoreFollowFeedPosts = false;
        }),
        first()
      )
      .toPromise();
  }

  _loadHotFeedPosts(reload: boolean = false) {
    this.loadingMoreHotFeedPosts = true;

    // Get the reader's public key for the request.
    let readerPubKey = "";
    if (this.globalVars.loggedInUser) {
      readerPubKey = this.globalVars.loggedInUser?.PublicKeyBase58Check;
    }

    const hotFeedPostHashes = _.map(this.globalVars.hotFeedPosts, "PostHashHex");
    return this.backendApi
      .GetHotFeed(readerPubKey, hotFeedPostHashes, this.FeedComponent.NUM_TO_FETCH)
      .pipe(
        tap(
          (res) => {
            if (res.HotFeedPage) {
              this.globalVars.hotFeedPosts = this.globalVars.hotFeedPosts.concat(res.HotFeedPage);
            }

            // Remove pinned post if it's been dismissed by the user
            if (
              this.globalVars.hotFeedPosts.length > 0 &&
              this.globalVars.hotFeedPosts[0].IsPinned &&
              this.backendApi.GetStorage("dismissedPinnedPostHashHex") === this.globalVars.hotFeedPosts[0].PostHashHex
            ) {
              this.globalVars.hotFeedPosts.shift();
            }
            for (let ii = 0; ii < this.globalVars.hotFeedPosts.length; ii++) {
              this.hotFeedPostHashes = this.hotFeedPostHashes.concat(this.globalVars.hotFeedPosts[ii]?.PostHashHex);
            }
          },
          (err) => {
            console.error(err);
            this.globalVars._alertError("Error loading posts: " + this.backendApi.stringifyError(err));
          }
        ),
        finalize(() => {
          this.loadingFirstBatchOfHotFeedPosts = false;
          this.loadingMoreHotFeedPosts = false;
        }),
        first()
      )
      .toPromise();
  }

  _loadTagFeedPosts(reload: boolean = false) {
    if (reload) {
      this.globalVars.tagFeedPosts = [];
      this.tagFeedPostHashes = [];
    }

    this.loadingMoreTagFeedPosts = true;

    // Get the reader's public key for the request.
    let readerPubKey = "";
    if (this.globalVars.loggedInUser) {
      readerPubKey = this.globalVars.loggedInUser?.PublicKeyBase58Check;
    }

    const tagFeedPostHashes = _.map(this.globalVars.tagFeedPosts, "PostHashHex");
    return this.backendApi
      .GetHotFeed(readerPubKey, tagFeedPostHashes, this.FeedComponent.NUM_TO_FETCH, "#" + this.tag.toLowerCase())
      .pipe(
        tap(
          (res) => {
            if (res.HotFeedPage) {
              // Filter out pinned posts.
              const hotFeedPage = _.filter(
                res.HotFeedPage,
                (hotFeedResult) =>
                  !hotFeedResult.IsPinned || hotFeedResult.Body.toLowerCase().includes("#" + this.tag.toLowerCase())
              );
              this.globalVars.tagFeedPosts = this.globalVars.tagFeedPosts.concat(hotFeedPage);
            }

            for (let ii = 0; ii < this.globalVars.tagFeedPosts.length; ii++) {
              this.tagFeedPostHashes = this.tagFeedPostHashes.concat(this.globalVars.tagFeedPosts[ii]?.PostHashHex);
            }
          },
          (err) => {
            console.error(err);
            this.globalVars._alertError("Error loading posts: " + this.backendApi.stringifyError(err));
          }
        ),
        finalize(() => {
          this.loadingMoreTagFeedPosts = false;
          this.loadingFirstBatchOfTagFeedPosts = false;
        }),
        first()
      )
      .toPromise();
  }

  _afterLoadingFollowingOnPageLoad() {
    this.isLoadingFollowingOnPageLoad = false;

    const defaultActiveTab = FeedComponent.HOT_TAB;

    if (!this.activeTab) {
      const storedTab = this.backendApi.GetStorage("mostRecentFeedTab");
      if (!storedTab) {
        this.activeTab = defaultActiveTab;
      } else {
        this.activeTab = storedTab;
        if (this.activeTab === "Hot 🔥") {
          this.activeTab = FeedComponent.HOT_TAB;
        }
      }
    }
    this.switchTab(this.activeTab, true);
  }

  handleTabClick(feedTab: string) {
    this.tracking.log("feed-tab : click", { feedTab });
    this.switchTab(feedTab, false);
  }

  /**
   * @param tab the selected tab
   * @param replaceUrl determines whether or not to preserve an entry in the
   * browser history. In the case where the route is entered without a tab
   * selected, we default to selecting the hotfeed which triggers a new
   * navigation event, but this initial navigation event should not add a new
   * history entry
   */
  private switchTab(tab: string, replaceUrl: boolean = false) {
    if (tab === FeedComponent.SHOWCASE_TAB) {
      window.open("https://polygram.cc", "_blank");
    } else {
      this.activeTab = tab;
      let commands = [];
      if (tab !== FeedComponent.TAG_TAB) {
        if (this.globalVars.loggedInUser) {
          // only store the selected tab if the user is logged in
          // logged out users will always see the hot feed
          this.backendApi.SetStorage("mostRecentFeedTab", tab);
        }
        this.tag = null;
        this.expandTagSelector = false;
        commands = ["/" + this.globalVars.RouteNames.BROWSE];
      }

      this.router.navigate(commands, {
        relativeTo: this.route,
        queryParams: { feedTab: this.activeTab },
        queryParamsHandling: "merge",
        replaceUrl,
      });

      this._onTabSwitch();
    }
  }

  static prependPostToFeed(postsToShow, postEntryResponse) {
    postsToShow.unshift(postEntryResponse);
  }

  // Note: the caller of this function may need to re-render the parentPost and grandparentPost,
  // since we update their CommentCounts
  static onPostHidden(postsToShow, postEntryResponse, parentPost, grandparentPost) {
    const postIndex = postsToShow.findIndex((post) => {
      return post.PostHashHex === postEntryResponse.PostHashHex;
    });

    if (postIndex === -1) {
      console.error(`Problem finding postEntryResponse in postsToShow in onPostHidden`, {
        postEntryResponse,
        postsToShow,
      });
    }

    // the current post (1) + the CommentCount comments/subcomments were hidden
    const decrementAmount = 1 + postEntryResponse.CommentCount;

    if (parentPost) {
      parentPost.CommentCount -= decrementAmount;
    }

    if (grandparentPost) {
      grandparentPost.CommentCount -= decrementAmount;
    }

    postsToShow.splice(postIndex, 1);
  }

  static findParentPostIndex(postsToShow, postEntryResponse) {
    return postsToShow.findIndex((post) => {
      return post.PostHashHex === postEntryResponse.ParentStakeID;
    });
  }

  static appendCommentAfterParentPost(postsToShow, postEntryResponse) {
    const parentPostIndex = FeedComponent.findParentPostIndex(postsToShow, postEntryResponse);
    const parentPost = postsToShow[parentPostIndex];

    // Note: we don't worry about updating the grandparent posts' commentCount in the feed
    parentPost.CommentCount += 1;

    // This is a hack to make it so that the new comment shows up in the
    // feed with the "replying to @[parentPost.Username]" content displayed.
    postEntryResponse.parentPost = parentPost;

    // Insert the new comment in the correct place in the postsToShow list.
    // TODO: This doesn't work properly for comments on subcomments (they appear in the wrong
    // place in the list), but whatever, we can try to fix this edge case later
    postsToShow.splice(parentPostIndex + 1, 0, postEntryResponse);

    // Add the post to the parent's list of comments so that the comment count gets updated
    parentPost.Comments = parentPost.Comments || [];
    parentPost.Comments.unshift(postEntryResponse);
  }
}
