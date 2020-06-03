/**
 * @license
 * Copyright DagonMetric. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found under the LICENSE file in the root directory of this source tree.
 */

import { Inject, Injectable, Injector, Optional } from '@angular/core';

import { BehaviorSubject, Observable, forkJoin, of } from 'rxjs';
import { map, share, take, tap } from 'rxjs/operators';

import { ConfigProvider } from './config-provider';
import { CONFIG_PROVIDER } from './config-provider-token';
import { ConfigSection } from './config-section';
import { CONFIG_OPTIONS, ConfigOptions } from './config-options';

export interface ConfigLoadingContext {
    status?: 'loading' | 'loaded';
}

interface OptionsLike {
    [key: string]: string | number | boolean | OptionsLike | null;
}

const OptionsSuffix = 'Options';

// eslint-disable-next-line prefer-arrow/prefer-arrow-functions
function mapOptionValues(options: OptionsLike, configSection: ConfigSection): void {
    const keys = Object.keys(options);
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(configSection, key)) {
            continue;
        }

        const optionsValue = options[key];
        const configValue = configSection[key];

        if (optionsValue === configValue) {
            continue;
        }

        if (configValue == null) {
            options[key] = null;
            continue;
        }

        if (optionsValue == null) {
            options[key] = configValue;
            continue;
        }

        if (typeof optionsValue === 'string') {
            if (typeof configValue === 'string') {
                options[key] = configValue;
            } else if (typeof configValue === 'number') {
                options[key] = (configValue as number).toString();
            } else if (typeof configValue === 'boolean') {
                options[key] = (configValue as boolean).toString();
            } else {
                options[key] = JSON.stringify(configValue);
            }
        } else if (typeof optionsValue === 'boolean') {
            if (typeof configValue === 'string') {
                options[key] = ['1', 'true', 'on'].indexOf(configValue.toLowerCase()) > -1;
            } else if (typeof configValue === 'boolean') {
                options[key] = configValue;
            } else if (typeof configValue === 'number') {
                options[key] = configValue === 1;
            } else {
                options[key] = false;
            }
        } else if (typeof optionsValue === 'number') {
            options[key] = Number(configValue) || 0;
        } else if (typeof optionsValue === 'object' && typeof configValue === 'object') {
            mapOptionValues(optionsValue, configValue);
        }
    }
}

@Injectable({
    providedIn: 'root'
})
export class ConfigService {
    readonly loadEvent: Observable<ConfigLoadingContext>;

    private readonly options: ConfigOptions;
    private readonly loadSubject = new BehaviorSubject<ConfigLoadingContext>({});
    private readonly fetchRequests: { [key: string]: Observable<ConfigSection> } = {};

    private loading = false;
    private completed = false;
    private cachedConfig: ConfigSection = {};
    private optionsRecord = new Map<string, unknown>();

    get providers(): ConfigProvider[] {
        return this.sortedConfigProviders;
    }

    private readonly sortedConfigProviders: ConfigProvider[];

    constructor(
        @Inject(CONFIG_PROVIDER) configProviders: ConfigProvider[],
        private readonly injector: Injector,
        @Optional() @Inject(CONFIG_OPTIONS) options?: ConfigOptions
    ) {
        this.sortedConfigProviders = configProviders.reverse();

        this.options = options || {};
        this.loadEvent = this.loadSubject.asObservable();
    }

    load(reLoad: boolean = false): Observable<ConfigSection> {
        return this.loadInternal(reLoad);
    }

    getValue(key: string): string | ConfigSection | null {
        const keyArray = key.split(/\.|:/);
        const result = keyArray.reduce((acc, current: string) => acc && acc[current], this.cachedConfig);
        if (result === undefined) {
            return null;
        }

        return result;
    }

    map<T>(optionsClass: new () => T): T {
        const optionsObj = this.injector.get<T>(optionsClass, new optionsClass());
        const normalizedKey = this.getNormalizedKey(optionsClass.name);
        const cachedOptions = this.optionsRecord.get(normalizedKey) as T;
        if (cachedOptions != null) {
            if (cachedOptions === optionsObj) {
                return cachedOptions;
            }

            this.optionsRecord.delete(normalizedKey);
        }

        const configSection = this.getValue(normalizedKey);

        if (configSection == null || typeof configSection !== 'object') {
            return optionsObj;
        }

        mapOptionValues(optionsObj as never, configSection);
        this.optionsRecord.set(normalizedKey, optionsObj);

        return optionsObj;
    }

    private getNormalizedKey(className: string): string {
        let normalizedKey = className;
        if (normalizedKey.length > OptionsSuffix.length && normalizedKey.endsWith(OptionsSuffix)) {
            normalizedKey = normalizedKey.substr(0, normalizedKey.length - OptionsSuffix.length);
        }

        normalizedKey = normalizedKey[0].toLowerCase() + normalizedKey.substr(1);

        return normalizedKey;
    }

    private loadInternal(reload: boolean): Observable<ConfigSection> {
        if (this.completed && !reload) {
            this.log('Configuration already loaded.');

            return of(this.cachedConfig);
        }

        if (!this.loading) {
            this.log('Cconfiguration loading started.');

            this.loading = true;
            this.completed = false;

            this.loadSubject.next({
                status: 'loading'
            });
        }

        const obs$ = forkJoin(
            this.providers.map((configProvider) => {
                const loaderName = configProvider.name;

                if (reload || !this.fetchRequests[loaderName]) {
                    const loaderObs = configProvider.load().pipe(
                        tap((config) => {
                            this.log(loaderName, config);
                        }),
                        share()
                    );

                    this.fetchRequests[loaderName] = loaderObs.pipe(take(1), share());
                }

                return this.fetchRequests[loaderName];
            })
        ).pipe(
            map((configs) => {
                let mergedConfig: ConfigSection = {};

                configs.forEach((config) => {
                    mergedConfig = { ...mergedConfig, ...config };
                });

                return mergedConfig;
            }),
            tap((config) => {
                this.cachedConfig = config;
                this.optionsRecord.clear();
            })
        );

        obs$.subscribe(
            () => {
                this.completed = true;
                this.loading = false;

                this.log('Configuration loading completed.');

                this.loadSubject.next({
                    status: 'loaded'
                });
            },
            () => {
                this.completed = false;
                this.loading = false;
            }
        );

        return obs$;
    }

    private log(msg: string, optionalParam?: unknown): void {
        if (!this.options.trace) {
            return;
        }

        if (optionalParam) {
            // eslint-disable-next-line no-console
            console.log(`[ConfigService] ${msg}, data: `, optionalParam);
        } else {
            // eslint-disable-next-line no-console
            console.log(`[ConfigService] ${msg}`);
        }
    }
}
