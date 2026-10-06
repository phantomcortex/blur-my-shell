import GObject from 'gi://GObject';

/// Number of new records after which records of garbage-collected objects are pruned.
const PRUNE_INTERVAL = 256;

function supports_destroy_signal(object) {
    const gtype = object?.constructor?.$gtype;
    return gtype && GObject.signal_lookup('destroy', gtype) !== 0;
}

/// Keeps track of signal connections in order to disconnect them easily.
///
/// Objects are only referenced weakly: some actors (for example Wayland surface actors, owned by
/// Mutter) are released by unref and never emit `destroy`, so holding them strongly here would
/// keep them, and their GPU textures, alive forever.
export const Connections = class Connections {
    constructor() {
        this.records = new WeakMap();
        this.live_records = new Set();
        this.records_since_prune = 0;
    }

    connect(object, signals, handler) {
        const names = Array.isArray(signals) ? signals : [signals];
        const record = this.get_record(object);
        const ids = [];

        for (const signal of names) {
            const id = object.connect(signal, handler);
            record.ids.add(id);
            ids.push(id);
        }
        return Array.isArray(signals) ? ids : ids[0];
    }

    get_record(object) {
        let record = this.records.get(object);
        if (record)
            return record;

        record = {
            ref: new WeakRef(object),
            ids: new Set(),
            destroy_id: null,
        };
        this.records.set(object, record);
        this.live_records.add(record);

        if (++this.records_since_prune >= PRUNE_INTERVAL)
            this.prune();

        if (supports_destroy_signal(object))
            record.destroy_id = object.connect('destroy', () => this.forget(object));

        return record;
    }

    forget(object) {
        const record = this.records.get(object);
        if (!record)
            return null;

        this.records.delete(object);
        this.live_records.delete(record);
        return record;
    }

    /// Drop the records whose object has been garbage-collected (their handlers died with it).
    prune() {
        this.records_since_prune = 0;
        for (const record of [...this.live_records]) {
            if (!record.ref.deref())
                this.live_records.delete(record);
        }
    }

    disconnect_all_for(object) {
        const record = this.forget(object);
        if (!record)
            return;

        for (const id of record.ids)
            this.raw_disconnect(object, id);
        if (record.destroy_id)
            this.raw_disconnect(object, record.destroy_id);
    }

    disconnect_all() {
        for (const record of [...this.live_records]) {
            const object = record.ref.deref();
            if (object)
                this.disconnect_all_for(object);
            else
                this.live_records.delete(record);
        }
    }

    disconnect(object, id) {
        const record = this.records.get(object);
        if (record)
            record.ids.delete(id);

        this.raw_disconnect(object, id);

        if (record && record.ids.size === 0) {
            this.forget(object);
            if (record.destroy_id)
                this.raw_disconnect(object, record.destroy_id);
        }
    }

    raw_disconnect(object, id) {
        if (!id)
            return;

        try {
            if (
                object instanceof GObject.Object
                && !GObject.signal_handler_is_connected(object, id)
            )
                return;

            object.disconnect(id);
        } catch (error) {
            this._warn(`error removing connection: ${error}; continuing`);
        }
    }

    _warn(str) {
        console.warn(`[Blur my Shell > connections]  ${str}`);
    }
};
