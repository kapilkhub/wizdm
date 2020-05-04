import { Router, Resolve, ActivatedRouteSnapshot, ParamMap } from '@angular/router';
import { Injectable, InjectionToken, Inject, Optional } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { map, tap, catchError, switchMap } from 'rxjs/operators';
import { SelectorResolver } from '@wizdm/content';
import { Observable, of } from 'rxjs';

// Optional configuration
export interface StaticConfig {

  path?: string;
}

// Optional configutation token
export const STATIC_CONFIG = new InjectionToken<StaticConfig>("wizdm.static.config");

export interface StaticContent {
  body: string;
  toc?: any;
  ref?: string;
}

export interface StaticCache {
  lang: string;
  [key:string]: string;
}

@Injectable()
export class StaticResolver implements Resolve<StaticContent> {

  private cache: StaticCache;
  private path: string; 
  
  constructor(private router: Router, 
              private http: HttpClient, 
              private selector: SelectorResolver,
              @Optional() @Inject(STATIC_CONFIG) config: StaticConfig) {


    // Initializes the source path according to the config oo defalts to 'assets/docs'
    this.path = !!config?.path ? (
      // Makes sure the given path ends with a slash
      config.path.endsWith('/') ? config.path : ( config.path + '/' )
      // Defaults to docs otherwise
    ) : 'assets/docs/';
  }

  /** The default language of the content manager */
  get defaultLang() { return this.selector.config.defaultValue; }

  /** Resolves the content loading the requested source file */
  public resolve(route: ActivatedRouteSnapshot): Observable<StaticContent> {
    
    // Resolves the language code from the route using the content selector resolver
    const lang = this.selector.resolve(route);

    // Resolves the source file path from the route
    const path = this.resolvePath(route.paramMap);

    console.log("Static requesting:", path);

    // Resets the cache whenever the requested language changes
    // Caching the content results in the following advantages:
    // 1. Skipping http.get() requests for already cached content provided the static module hasn't been reloaded
    // 2. Skipping markdown re-rendering of unchanged content (likely the toc) since the cached string doesn't change
    if(lang !== this.cache?.lang) { this.cache = { lang }; }
    
    // Loads the main .md file
    return this.loadFile(lang, path, 'text').pipe(
      // Gets the body contents...
      switchMap( body => {

        // Parses the comments looking for options
        const options = this.parseComments(body);

        // Returns the body plus the options when no toc is found
        if(!options.toc) { return of({ body, path, ...options }); }
        
        // Loads the toc file if any
        return this.loadFile(lang, options.toc, 'json').pipe( 
          // And returns the body, the toc and the options
          map( toc => ({ body, path, ...options, toc }) 
        ));
      }),
      
      // Redirects to NotFound when no content is found
      catchError( (e: HttpErrorResponse) => {
  
        console.error('Unable to load, edirecting to not-found', e);

        this.router.navigate(['/not-found']); 
        
        return of({ body: '' });
      })
    );
  }

  /** Load the file from the specified language sub-folder */
  private loadFile(lang: string, name: string, responseType: 'text'|'json' = 'text'): Observable<any> {

    // Returns the cached version of the content, if any
    if(this.cache[name]) { return of(this.cache[name]); }

    const fileExt = (name.match(/\.\w+$/)?.[0]) || ('.' + (responseType === 'text' ? 'md' : responseType));

    // Computes the full path removing the extension, if any
    const fullPath = this.path + lang + '/' + name.replace(/\.\w+$/, '') + fileExt;

    console.log("Static loading:", fullPath);

    // Loads the requested file first
    return this.http.request('GET', fullPath, { observe: 'body', responseType }).pipe( 

      // Catches the possible error
      catchError( (e: HttpErrorResponse) => {

        // On file not found (404) of localized content...
        if(lang !== this.defaultLang && e.status === 404) { 
        
          // Reverts to the default language
          const defaultPath = this.path + this.defaultLang + '/' + name.replace(/\.\w+$/, '') + fileExt;
          
          console.log('404 File not found, reverting to default language:', defaultPath);
          
          // Loads the same document in the default language instead
          return this.http.request('GET', defaultPath, { observe: 'body', responseType });
        }

        throw e;
      }),
      // Caches the content for further use
      tap( data => this.cache[name] = data )
    );
  }

  /** Path resolver helper */
  private resolvePath(params: ParamMap): string {
  
    return params && params.keys
    // Matches all the params starting with 'path'
    .filter( key => !!key.match(/^path\d*$/) )
    // Gets the corresponding values
    .map( key => params.get(key) )
    // Joins the parameters into the full path
    .join('/');
  }

  /** Parses the comments from source md file */
  private parseComments(source): { [key:string]: string } {

    const out = {};

    if(!source) { return out; }

    const comments = /<!--([\s\S]*?)-->/g;
    const pairs = /\s*(\w+):\s*([\w-_.]*)\s*/g;

    this.parse(comments, source, comment => {

      this.parse(pairs, comment[1], pair => {

        out[ pair[1] ] = pair[2];

      });
    });

    return out;
  }

  private parse(rx: RegExp, source: string, fn: (match: RegExpExecArray) => void) {

    if(typeof(fn) !== 'function') { throw new Error("fn must be a function"); }

    let match;
    while( match = rx.exec( source ) ) {

      // Prevents the zero-length match infinite loop for all browsers
      if(match.index == rx.lastIndex) { rx.lastIndex++ };

      fn(match);
    }
  }
}
