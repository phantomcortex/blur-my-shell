import St from 'gi://St';

import { get_supported_effects } from '../effects/effects.js';

/// Maximum number of unused effects kept per effect type. Detached effects still hold their last
/// offscreen textures (Cogl pipelines keep a reference to them until the effect is finalized), so
/// the pool must stay small: anything over this limit is released instead.
const MAX_POOLED_EFFECTS = 2;

/// An object to manage effects (by not destroying them all the time)
export const EffectsManager = class EffectsManager {
    constructor(connections) {
        this.connections = connections;
        this.used = new Set();
        this.SUPPORTED_EFFECTS = get_supported_effects();

        Object.keys(this.SUPPORTED_EFFECTS).forEach(effect_name => {
            // init the arrays containing each unused effect
            this[effect_name + '_effects'] = [];

            // init the functions for each effect
            this['new_' + effect_name + '_effect'] = function (params) {
                let effect;
                if (this[effect_name + '_effects'].length > 0) {
                    effect = this[effect_name + '_effects'].pop();
                    effect.set({
                        ...this.SUPPORTED_EFFECTS[effect_name].class.default_params, ...params
                    });
                } else {
                    effect = new this.SUPPORTED_EFFECTS[effect_name].class({
                        ...this.SUPPORTED_EFFECTS[effect_name].class.default_params, ...params
                    });
                    this.connect_to_destroy(effect);
                }

                this.used.add(effect);
                return effect;
            };
        });
    }

    connect_to_destroy(effect) {
        const update_actor = () => {
            const actor = effect.get_actor();
            if (actor === effect._bms_actor)
                return;

            this.disconnect_actor_destroy(effect);
            effect._bms_actor = actor;
            if (actor)
                effect._bms_actor_destroy_id = actor.connect(
                    'destroy', () => this.remove(effect, true)
                );
        };

        this.connections.connect(effect, 'notify::actor', update_actor);
        update_actor();
    }

    disconnect_actor_destroy(effect) {
        if (effect._bms_actor && effect._bms_actor_destroy_id) {
            effect._bms_actor.disconnect(effect._bms_actor_destroy_id);
        }
        effect._bms_actor = null;
        effect._bms_actor_destroy_id = null;
    }

    remove(effect) {
        const actor = effect.get_actor();
        if (actor)
            actor.remove_effect(effect);
        this.disconnect_actor_destroy(effect);

        if (this.used.delete(effect)) {
            const effect_name = Object.keys(this.SUPPORTED_EFFECTS).find(
                name => effect instanceof this.SUPPORTED_EFFECTS[name].class
            );
            const pool = effect_name ? this[effect_name + '_effects'] : null;

            if (pool && pool.length < MAX_POOLED_EFFECTS)
                pool.push(effect);
            else
                this.release(effect);
        }
    }

    /// Drop every reference we hold on an effect that is not attached anymore, so that it (and its
    /// GPU textures) can be finalized. The effects connect to the theme context with
    /// `connectObject`, which would otherwise keep them alive for the whole session.
    release(effect) {
        const theme_context = St.ThemeContext.get_for_stage(global.stage);
        [effect, effect.chained_effect].forEach(e => {
            if (!e)
                return;
            e.get_actor()?.remove_effect(e);
            theme_context.disconnectObject(e);
        });
        this.disconnect_actor_destroy(effect);
        this.connections.disconnect_all_for(effect);
    }

    destroy_all() {
        const immutable_used_list = [...this.used];
        immutable_used_list.forEach(effect => this.remove(effect));
        Object.keys(this.SUPPORTED_EFFECTS).forEach(effect_name => {
            const pool = this[effect_name + '_effects'];
            pool.forEach(effect => this.release(effect));
            pool.splice(0, pool.length);
        });
    }

    _warn(str) {
        console.warn(`[Blur my Shell > effects mng]  ${str}`);
    }
};
