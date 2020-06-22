import { Danbooru } from "../../components/api/Danbooru";
import { XM } from "../../components/api/XM";
import { ModuleController } from "../../components/ModuleController";
import { RE6Module, Settings } from "../../components/RE6Module";
import { DomUtilities } from "../../components/structure/DomUtilities";
import { Form, FormElement } from "../../components/structure/Form";
import { Modal } from "../../components/structure/Modal";
import { Tabbed } from "../../components/structure/Tabbed";
import { Util } from "../../components/structure/Util";
import { ThumbnailClickAction, ThumbnailEnhancer } from "../search/ThumbnailsEnhancer";
import { Subscription } from "./Subscription";

export class SubscriptionManager extends RE6Module {

    /** How often should the subscriptions be refreshed _on their own_. */
    private static updateInterval = 60 * 60 * 1000; // 1 hour

    /** Used to invalidate cache if the format changes */
    private static cacheVersion = 1;

    /** Used to block manual updates while an interval update is in progress */
    private static updateInProgress = false;

    /** Map of active subscription modules */
    private subscriptions = new Map<string, SubscriptionElement>();

    /** Header button that opens the subscription modal */
    private $openSubsButton: JQuery<HTMLElement>;

    /** True if the notifications window has been opened since page load */
    private notificationsAlreadyOpened = false;

    protected getDefaultSettings(): Settings {
        return {
            enabled: true,
            lastUpdate: 0,
            cacheSize: 60
        };
    }

    public async create(): Promise<void> {
        super.create();

        // Fetch necessary data
        const settings = this.fetchSettings(["lastUpdate", "cacheVersion"]),
            cacheInvalid = settings.cacheVersion === undefined || settings.cacheVersion < SubscriptionManager.cacheVersion,
            shouldUpdate = this.getShouldUpdate(settings.lastUpdate);

        // Set the update date immediately, to prevent other tabs from updating needlessly
        // It is still possible that a collision may occur if two tabs update at the exact same time
        if (shouldUpdate) { this.pushSettings("lastUpdate", new Date().getTime()); }
        SubscriptionManager.updateInProgress = true;

        // Set the latest cache version, presuming that the script will clear the cache later
        if (cacheInvalid) this.pushSettings("cacheVersion", SubscriptionManager.cacheVersion);

        // Create a button in the header
        this.$openSubsButton = DomUtilities.addSettingsButton({
            name: `<i class="fas fa-bell"></i>`,
            title: "Notifications",
            attr: {
                "data-loading": "true",
                "data-updates": "0",
            },
            linkClass: "update-notification",
        });

        // Create structure for the subscription interface
        const content = [];
        const updateThreads: Promise<boolean>[] = [];

        let tabIndex = 0;
        this.subscriptions.forEach((data, name) => {
            data.tabElement = $("<a>")
                .attr({
                    "data-loading": "false",
                    "data-updates": "0",
                })
                .addClass("update-notification")
                .html(data.instance.getName());
            data.tabIndex = tabIndex;
            data.content = $("<div>")
                .addClass("subscriptions-list subscription-" + data.instance.getName())
                .attr({
                    "data-subscription-class": name,
                    "data-updates": "0",
                })
                .html(` loading `);

            // If the stored setting is different from a hard-coded value,
            // the cache format must have changed and data must be cleared
            if (cacheInvalid) data.instance.clearCache();

            content.push({ name: data.tabElement, page: data.content });
            updateThreads.push(this.initSubscription(data, shouldUpdate, settings.lastUpdate))
            tabIndex++;
        });
        content.push({ name: "Info", page: this.getInfoPage().get() });

        const subsTabs = new Tabbed({
            name: "settings-tabs",
            content: content
        });

        // Create the modal
        const modal = new Modal({
            title: "Subscriptions",
            triggers: [{ element: this.$openSubsButton }],
            escapable: false,
            reserveHeight: true,
            content: subsTabs.get(),
            position: { my: "right top", at: "right top" }
        });

        // Update the subscription content
        Promise.all(updateThreads).then(() => {
            SubscriptionManager.updateInProgress = false;
            SubscriptionManager.trigger("update");
            setInterval(() => { // Update the timers every minute
                SubscriptionManager.trigger("update");
            }, 60 * 1000);

            this.$openSubsButton.attr("data-loading", "false");
            this.refreshHeaderNotifications();

            if (modal.isOpen()) {
                const activeTab = subsTabs.get().tabs("option", "active");
                window.setTimeout(() => {
                    this.clearTabNotification(activeTab);
                }, 1000);
            }

            // Clear the notifications if the user opened the tab
            modal.getElement().on("dialogopen", () => {
                if (!this.notificationsAlreadyOpened) {
                    this.notificationsAlreadyOpened = true;

                    let index = 0;
                    for (const sub of this.subscriptions) {
                        if (parseInt(sub[1].tabElement.attr("data-updates")) > 0) {
                            subsTabs.get().tabs("option", "active", index);
                            break;
                        }
                        index++;
                    }
                }
                this.clearTabNotification(subsTabs.get().tabs("option", "active"));
                window.setTimeout(() => {
                    this.clearTabNotification(subsTabs.get().tabs("option", "active"));
                }, 1000);
            });

            subsTabs.get().on("tabsactivate", (event, tabProperties) => {
                this.clearTabNotification(tabProperties.newTab.index());
            });
        });
    }

    /**
     * Adds a subscriber to the list of them and creates a tab for it.
     * @param instance subscriber to be queued for update check
     */
    public static register(moduleList: any | any[]): void {
        if (!Array.isArray(moduleList)) moduleList = [moduleList];

        moduleList.forEach(async (moduleClass: any) => {
            const instance = ModuleController.get<Subscription>(moduleClass);
            const manager = this.getInstance() as SubscriptionManager;
            manager.subscriptions.set(moduleClass.prototype.constructor.name, { instance: instance });
        });
    }

    /**
     * Returns the SubscriptionElement corresponding to the provided ID.  
     * The ID can be either the subscription name as a string, or its numeric tab ID
     * @param id Subscription ID
     */
    public getSubscription(id: string | number): SubscriptionElement {
        if (typeof id === "string") return this.subscriptions.get(id);
        for (const value of this.subscriptions.values())
            if (value.tabIndex === id) { return value; }
        return undefined;
    }

    /**
     * Checks if the subscriptions should be updated
     * @param lastUpdate Timestamp of the previous update
     */
    private getShouldUpdate(lastUpdate: number): boolean {
        const nowFake = this.fetchSettings("now"); // Used for debugging purposes
        const now = nowFake !== undefined ? nowFake : new Date().getTime();
        lastUpdate = lastUpdate ? lastUpdate : this.fetchSettings("lastUpdate");
        return !SubscriptionManager.updateInProgress &&
            (now - lastUpdate) >= SubscriptionManager.updateInterval;
    }

    /**
     * Builds a subscription settings page, containing various controls
     */
    private getInfoPage(): Form {
        const lastUpdate = this.fetchSettings("lastUpdate");

        SubscriptionManager.on("update.main", () => {
            const lastUpdate = this.fetchSettings("lastUpdate");
            $("span#subscriptions-lastupdate").html(getLastUpdateText(lastUpdate));
            $("span#subscriptions-nextupdate").html(getNextUpdateText(lastUpdate));

            $("i#subscription-action-update").toggleClass("fa-spin", SubscriptionManager.updateInProgress);
        });

        return new Form({ id: "subscriptions-controls", columns: 2, parent: "div#modal-container" }, [
            // List and manage active subscriptions
            Form.header("Subscriptions"),
            makeSubSection(this.getSubscription("PoolSubscriptions").instance, 1),
            makeSubSection(this.getSubscription("ForumSubscriptions").instance, 1),
            makeSubSection(this.getSubscription("TagSubscriptions").instance, 2),
            makeSubSection(this.getSubscription("CommentSubscriptions").instance, 2),
            Form.hr(),

            // Settings
            Form.header("Settings"),
            Form.section({ id: "settings", columns: 2 }, [
                Form.input(
                    "template", this.fetchSettings("cacheSize"), "Cache Size", "column", { pattern: "^(1?[0-9][0-9]|200)$" },
                    async (event, data) => {
                        if (!(event.target as HTMLInputElement).checkValidity()) return;
                        await this.pushSettings("cacheSize", parseInt(data));
                    }
                ),
                Form.spacer("column"),
                Form.div(`<div class="unmargin">Number of items kept in the update cache. Must be at least 10, but no more than 200. Large values may lead to performance drops.</div>`, "mid"),
            ]),
            Form.hr(),

            // Status and Controls
            Form.section({ id: "status", columns: 2 }, [
                Form.header("Other"),
                Form.div($("<span>").attr("id", "subscriptions-lastupdate").html(getLastUpdateText(lastUpdate)), "mid", "Last Update:"),
                Form.div($("<span>").attr("id", "subscriptions-nextupdate").html(getNextUpdateText(lastUpdate)), "mid", "Next Update:"),
                Form.button(
                    "triggerupdate", `<i class="fas fa-sync-alt fa-xs fa-spin" id="subscription-action-update"></i> Manual Update`, undefined, "column", () => {
                        if (SubscriptionManager.updateInProgress) {
                            Danbooru.notice("Update is already in progress");
                            return;
                        }

                        SubscriptionManager.updateInProgress = true;
                        this.pushSettings("lastUpdate", new Date().getTime());
                        SubscriptionManager.trigger("update");

                        this.$openSubsButton.attr({
                            "data-loading": "true",
                            "data-updates": "0",
                        });

                        this.fetchSettings("lastUpdate", true).then((lastUpdate) => {
                            const updateThreads: Promise<boolean>[] = [];
                            this.subscriptions.forEach(async (subscription) => {
                                subscription.tabElement.attr("data-updates", "0");
                                updateThreads.push(new Promise(async (resolve) => {
                                    await subscription.instance.refreshSettings();
                                    subscription.content[0].innerHTML = "";
                                    resolve(await this.initSubscription(subscription, true, lastUpdate));
                                }));
                            });
                            return Promise.all(updateThreads);
                        }).then(() => {
                            SubscriptionManager.updateInProgress = false;
                            SubscriptionManager.trigger("update");

                            this.$openSubsButton.attr("data-loading", "false");
                            this.refreshHeaderNotifications();
                        });
                    }
                ),
                Form.button(
                    "clear-cache", "Clear Cache", undefined, "column", () => {
                        this.subscriptions.forEach(async (subscription) => {
                            await subscription.instance.clearCache();
                            subscription.content[0].innerHTML = "";
                        });
                    }
                ),
            ], undefined, "mid"),
        ]);

        /** Formats the last update timestamp into a readable date */
        function getLastUpdateText(lastUpdate: number): string {
            if (SubscriptionManager.updateInProgress) return "In Progress . . .";
            else if (lastUpdate === 0) return "Never";
            else return Util.timeAgo(lastUpdate);
        }

        /** Formats the next update timestamp into a readable date */
        function getNextUpdateText(lastUpdate: number): string {
            if (SubscriptionManager.updateInProgress) return "In Progress . . .";
            else if (lastUpdate === 0) return Util.timeAgo(new Date().getTime() + SubscriptionManager.updateInterval);
            else return Util.timeAgo(lastUpdate + SubscriptionManager.updateInterval + (60 * 1000));
        }

        /** Creates a form section that lists currently subscribed items */
        function makeSubSection(instance: Subscription, columns: number): FormElement {
            const $subsSection = $("<div>").addClass("subscriptions-manage-list col-" + columns),
                data = instance.fetchSettings<SubscriptionSettings>("data");
            Object.keys(data).forEach((key) => {
                formatSubSectionEntry(instance, key, data[key]).appendTo($subsSection);
            });

            return Form.subsection({ id: Util.makeID(), columns: 2, collapseBadge: Object.keys(data).length }, instance.getName(), [
                Form.div($subsSection, "mid"),
            ], undefined, "mid");
        }

        /** Creates and returns an entry for the `makeSubSection()` method */
        function formatSubSectionEntry(instance: Subscription, key: string, entry: SubscriptionSettingsData): JQuery<HTMLElement> {
            const output = $("<item>");

            // Subscribe / Unsubscribe Buttons
            let currentlySubbed = true;
            const heart = $("<i>").addClass("fas fa-heart");
            $("<a>")
                .append(heart)
                .appendTo(output)
                .addClass("sub-manage-unsub")
                .on("click", async (event): Promise<void> => {
                    event.preventDefault();
                    const subData = await instance.fetchSettings<SubscriptionSettings>("data", true);
                    if (currentlySubbed) {
                        delete subData[key];
                        Danbooru.notice("Successfully unsubscribed");
                    } else {
                        subData[key] = entry;
                        Danbooru.notice("Successfully subscribed");
                    }
                    instance.pushSettings("data", subData);
                    currentlySubbed = !currentlySubbed;
                    heart.toggleClass("fas far");
                });

            // Link to the entry page
            const link: JQuery<HTMLElement> = $("<a>").html(entry.name ? entry.name : key).appendTo(output);
            switch (instance.getName()) {
                case "Pools": { link.attr("href", "/pools/" + key); break; }
                case "Forums": { link.attr("href", "/forum_topics/" + key); break; }
                case "Tags": { link.attr("href", "/posts?tags=" + key); break; }
                case "Comments": { link.attr("href", "/posts/" + key); break; }
            }

            return output;
        }
    }

    private refreshHeaderNotifications(): number {
        let totalCount = 0;
        this.subscriptions.forEach((subscription) => {
            totalCount += parseInt(subscription.tabElement.attr("data-updates"));
        });
        this.$openSubsButton.attr("data-updates", totalCount);
        return totalCount;
    }

    private refreshTabNotifications(subscription: SubscriptionElement): number {
        const curCount = subscription.content.find(".new").length;
        subscription.content.attr("data-updates", curCount);
        subscription.tabElement.attr("data-updates", curCount);
        return curCount;
    }

    /** Clears the notifications for the specified tab */
    private async clearTabNotification(tabIndex: number): Promise<boolean> {
        const subscription = this.getSubscription(tabIndex);
        if (subscription === undefined) return;

        // Clear the `new` class that is counted by `refreshNotifications()`
        // `new-visited` should have the same exact styling as `new`
        const newItems = subscription.content.find(".new").get();
        for (const item of newItems) { $(item).removeClass("new").addClass("new-viewed"); }

        // Recount notifications. The cache can get updated in the background, no need to wait
        this.refreshTabNotifications(subscription);
        this.refreshHeaderNotifications();

        // Remove the `new` flags from the cached data
        const cache = new UpdateCache(
            await subscription.instance.fetchSettings("cache"),
            this.fetchSettings("cacheSize")
        );

        cache.forEach((entry) => {
            delete entry["new"];
            return entry;
        });

        subscription.instance.pushSettings("cache", cache.getData());
    }

    /**
     * Processes the passed subscription
     * @param sub Subscription to process
     * @param shouldUpdate True if entries need to be loaded, false otherwise
     * @param lastUpdate Last update timestamp
     */
    public async initSubscription(sub: SubscriptionElement, shouldUpdate: boolean, lastUpdate: number): Promise<boolean> {
        this.addSubscribeButtons(sub.instance);

        sub.tabElement.attr("data-loading", "true");
        sub.content[0].innerHTML = "";
        const status = $("<div>")
            .addClass("subscription-load-status")
            .html("Loading . . .")
            .appendTo(sub.content);

        // Don't update if the last check was pretty recently
        let updates: UpdateData = {};
        if (shouldUpdate) updates = await sub.instance.getUpdatedEntries(lastUpdate, status);

        await this.addUpdateEntries(sub, updates);

        sub.tabElement.attr("data-loading", "false");
        this.refreshTabNotifications(sub);

        return Promise.resolve(true);
    }

    /**
     * Adds the subscribe / unsubscribe buttons for the provided subscription
     * @param instance Subscription instance
     */
    public addSubscribeButtons(instance: Subscription): void {
        let subscriptionData: SubscriptionSettings = instance.fetchSettings("data");

        const elements = instance.getButtonAttachment().get();
        for (const element of elements) {
            const $element = $(element);

            // Don't add subscription buttons if they already exist
            if ($element.find("button.subscribe, a.subscribe").length > 0) continue;

            const id = instance.getSubscriberId($element);

            // Create buttons
            const $subscribeButton = instance.makeSubscribeButton();
            const $unsubscribeButton = instance.makeUnsubscribeButton();

            if (subscriptionData[id] === undefined) $unsubscribeButton.addClass("display-none");
            else $subscribeButton.addClass("display-none");

            instance.insertButton($element, $subscribeButton);
            instance.insertButton($element, $unsubscribeButton);

            // Process subscribe / unsubscribe actions
            let processing = false;
            $subscribeButton.click(async (event) => {
                event.preventDefault();

                if (processing) return;
                processing = true;

                execSubscribe(id, $subscribeButton, $unsubscribeButton, $element)
                    .then(() => { processing = false; });
            });
            $unsubscribeButton.click(async (event) => {
                event.preventDefault();

                if (processing) return;
                processing = true;

                execUnsubscribe(id, $subscribeButton, $unsubscribeButton)
                    .then(() => { processing = false; });
            });
        }

        async function execSubscribe(id: string, $subscribeButton: JQuery<HTMLElement>, $unsubscribeButton: JQuery<HTMLElement>, $element: JQuery<HTMLElement>): Promise<boolean> {
            subscriptionData = await instance.fetchSettings("data", true);
            subscriptionData[id] = { name: instance.getSubscriberName($element), };

            $subscribeButton.addClass("display-none");
            $unsubscribeButton.removeClass("display-none");

            return instance.pushSettings("data", subscriptionData);
        }

        async function execUnsubscribe(id: string, $subscribeButton: JQuery<HTMLElement>, $unsubscribeButton: JQuery<HTMLElement>): Promise<boolean> {
            subscriptionData = await instance.fetchSettings("data", true);
            delete subscriptionData[id];

            $subscribeButton.removeClass("display-none");
            $unsubscribeButton.addClass("display-none");

            return instance.pushSettings("data", subscriptionData);
        }
    }

    /**
     * Adds the passed updates to the tab of the subscription module
     * @param sub Subscription module
     * @param updates Updates to process
     */
    public async addUpdateEntries(sub: SubscriptionElement, updates: UpdateData): Promise<number> {
        const cache = new UpdateCache(sub.instance.fetchSettings("cache"), this.fetchSettings("cacheSize"));
        if (Object.keys(updates).length > 0) {
            cache.push(updates);
            await sub.instance.pushSettings("cache", cache.getData());
        }

        sub.content[0].innerHTML = "";  // Clear the update statuses as late as possible
        if (cache.getSize() > 0) sub.content.append(this.createCacheDivider());

        cache.getIndex().forEach((timestamp) => {
            sub.content.append(this.createUpdateEntry(cache, timestamp, sub.instance));
        });

        const clickAction = ModuleController.get(ThumbnailEnhancer).fetchSettings("clickAction");

        const previewThumbs = sub.content.find<HTMLElement>("div.subscription-update-preview > a").get();
        for (const element of previewThumbs) {
            const $link = $(element);
            let dbclickTimer: number;
            let prevent = false;

            $link.on("click.re621.thumbnail", (event) => {
                if (event.button !== 0) { return; }
                event.preventDefault();

                dbclickTimer = window.setTimeout(() => {
                    if (!prevent) {
                        $link.off("click.re621.thumbnail");
                        $link[0].click();
                    }
                    prevent = false;
                }, 200);
            }).on("dblclick.re621.thumbnail", (event) => {
                if (event.button !== 0) { return; }

                event.preventDefault();
                window.clearTimeout(dbclickTimer);
                prevent = true;

                if (clickAction === ThumbnailClickAction.NewTab) XM.Util.openInTab(window.location.origin + $link.attr("href"), false);
                else {
                    $link.off("click.re621.thumbnail");
                    $link[0].click();
                }
            });
        }

        return Promise.resolve(cache.getIndex()[0]);
    }

    /**
     * Creates a divider between cached items and the ones added by an update.  
     * Should be inserted at the very beginning of the stack, actual sorting is done by CSS
     */
    private createCacheDivider(): JQuery<HTMLElement> {
        const $content = $("<div>")
            .addClass("subscription-update notice notice-cached");

        $("<div>")
            .addClass("subscription-update-title")
            .html("Older Updates")
            .appendTo($content);

        return $content;
    }

    /**
     * Creates a subscription update element based on the provided data and the subscription's definition
     * @param timeStamp Time when the update was created
     * @param data Update data
     * @param actions Subscription definition
     * @param customClass Custom class to add to the element
     */
    private createUpdateEntry(cache: UpdateCache, timestamp: number, subscription: Subscription, customClass?: string): JQuery<HTMLElement> {
        const actions = subscription.updateActions,
            data = cache.getItem(timestamp);

        const $content = $("<div>")
            .addClass("subscription-update" + (customClass ? " " + customClass : "") + (data.new ? " new" : ""));
        const timeAgo = Util.timeAgo(timestamp);
        const timeString = new Date(timestamp).toLocaleString();

        // ===== Create Elements =====
        // Image
        const $imageDiv = $("<div>")
            .addClass("subscription-update-preview")
            .appendTo($content);

        const $image = $("<img>")
            .attr({
                "src": DomUtilities.getPlaceholderImage(),
                "data-src": actions.imageSrc(data),
                "title": actions.updateText(data) + "\n" + timeAgo + "\n" + timeString
            })
            .addClass("lazyload")
            .on("error", () => { if (actions.imageRemoveOnError) $content.remove(); });

        if (actions.imageHref === undefined) $image.appendTo($imageDiv);
        else
            $("<a>")
                .addClass("subscription-update-thumbnail")
                .attr("href", actions.imageHref(data))
                .appendTo($imageDiv)
                .append($image);

        // Title
        const $title = $("<div>")
            .addClass("subscription-update-title")
            .appendTo($content);

        if (actions.updateHref === undefined)
            $("<div>")
                .html(actions.updateText(data))
                .attr("data-id", data.id)
                .appendTo($title);
        else
            $("<a>")
                .html(actions.updateText(data))
                .attr({
                    "href": actions.updateHref(data),
                    "data-id": data.id,
                })
                .appendTo($title);

        if (data.nameExtra)
            $("<span>")
                .addClass("subscriptions-update-title-extra")
                .html(data.nameExtra)
                .appendTo($title);

        // Remove from Cache
        const $remove = $("<div>")
            .addClass("subscription-update-remove")
            .appendTo($content);

        $("<a>")
            .html(`<i class="fas fa-times"></i>`)
            .attr("title", "Remove")
            .appendTo($remove)
            .click((event) => {
                event.preventDefault();
                cache.deleteItem(timestamp);
                subscription.pushSettings("cache", cache.getData());
                $content.css("display", "none");
            });

        // Link to "All Posts" page
        const $full = $("<div>")
            .addClass("subscription-update-full")
            .appendTo($content);

        if (actions.sourceHref === undefined) {
            $("<div>")
                .html(actions.sourceText(data))
                .appendTo($full);
        } else {
            $("<a>")
                .attr("href", actions.sourceHref(data))
                .html(actions.sourceText(data))
                .appendTo($full);
        }

        // Last Updated
        const $date = $("<div>")
            .addClass("subscription-update-date")
            .appendTo($content);
        $("<span>")
            .html(timeAgo)
            .attr("title", timeString)
            .appendTo($date);

        return $content;
    }

}

/** Handles the storage and organization of update cache */
class UpdateCache {

    private data: UpdateData;
    private index: number[];

    private maxSize: number;

    /**
     * Create a new UpdateCache based on stored data  
     * Don't add _new_ data here, it should be processed through the `push()` method
     * @param data Update data
     * @param maxSize Maximum cache size
     */
    public constructor(data: UpdateData, maxSize: number) {
        this.data = data === undefined ? {} : data;
        this.updateIndex();
        this.maxSize = maxSize;
    }

    /** Returns the stored cache data as an object */
    public getData(): UpdateData {
        return this.data;
    }

    /**
     * Returns the sorted index of cache's timestamps.  
     * Items are sorted in descending order (newest first).  
     */
    public getIndex(): number[] {
        return this.index;
    }

    /** Returns cache's current size */
    public getSize(): number {
        return this.index.length;
    }

    /**
     * Returns an item corresponding to the provided timestamp
     * @param timestamp Timestamp to look for
     */
    public getItem(timestamp: number): UpdateContent {
        return this.data[timestamp];
    }

    /**
     * Removes an item with the provded timestamp from cache
     * @param timestamp Timestamp to look for
     */
    public deleteItem(timestamp: number): void {
        const el = this.index.indexOf(timestamp);
        if (el !== -1) {
            this.index.splice(el, 1);
            delete this.data[timestamp];
        }
    }

    /**
     * Adds new data to cache.  
     * Note that all updates added through this method are flagged as "new".
     * @param newData Data to add to cache
     */
    public push(newData: UpdateData): void {
        Object.keys(newData).forEach((key) => {
            this.data[key] = newData[key];
        });
        this.updateIndex();
        this.trim();
    }

    /**
     * Refreshes the cache index.  
     * Should be executed every time an item is added to or removed from cache
     */
    private updateIndex(): void {
        this.index = Object.keys(this.data)
            .map(x => parseInt(x))
            .sort((a, b) => b - a); // newest to oldest
    }

    /**
     * Processes the cache, removing duplicate entries and trimming to match the maximum size.  
     * Note that this method presumes that the cache index is already up to date.  
     */
    private trim(): void {
        // Remove all non-unique updates
        // Forum posts may get replies all the time, only the recent one is important
        const uniqueKeys = [];
        this.index.forEach((timestamp) => {
            const update: UpdateContent = this.data[timestamp];
            if (uniqueKeys.indexOf(update.id) === -1)
                uniqueKeys.push(update.id);
            else delete this.data[timestamp];
        });

        // Re-index the updated data
        this.updateIndex();

        // Trims the index to maxSize, then removes the unwanted items from the data
        const chunks = Util.chunkArray(this.index, this.maxSize, true);
        this.index = chunks[0];
        chunks[1].forEach((entry: number) => { delete this.data[entry]; })
    }

    /**
     * Executes the provided function on every element in the cache.  
     * The function **must** return the new element value.  
     * @param fn Function to execute
     */
    public forEach(fn: (n: UpdateContent) => UpdateContent): void {
        this.index.forEach((entry) => {
            this.data[entry] = fn(this.data[entry]);
        });
    }
}

/** Container for multiple `UpdateContent` entries */
export interface UpdateData {
    [timestamp: number]: UpdateContent;
}

/** Contains data as it is passed from a subscription module or stored in cache */
export interface UpdateContent {
    /** Entry's unique ID. This can be forum_id, pool_id, etc.*/
    id: number;

    /** Name of the entry - topic title, pool name, etc */
    name: string;

    /** Extra text added to the name, but outside of the link */
    nameExtra?: string;

    /** MD5 hash of the related image */
    md5: string;

    /** Any extra information that needs to be passed to the manager */
    extra?: any;

    /** True for items that have been added by the latest update */
    new?: boolean;
}

export interface SubscriptionSettings {
    [id: string]: SubscriptionSettingsData;
}

interface SubscriptionSettingsData {
    md5?: string;
    lastId?: number;
    name?: string;
}

interface SubscriptionElement {
    /** Subscription instance */
    instance: Subscription;

    /** Tab selection element */
    tabElement?: JQuery<HTMLElement>;

    /** Index of the tab selection element in the list */
    tabIndex?: number;

    /** Tab contents */
    content?: JQuery<HTMLElement>;
}
