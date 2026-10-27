import type {Credentials} from './desktop-https';
import {AdapterError} from './errors';
/** Memory-only credential owner. No persistence, encryption scheme or platform-private API. */
export class SessionCredentials {
  #value:Credentials|null=null;
  set(value:Credentials):void {
    if(typeof value?.username!=='string'||typeof value?.password!=='string'||value.username.length>1024||value.password.length>4096)
      throw new AdapterError('AUTH');
    this.#value={username:value.username,password:value.password};
  }
  get():Credentials|null{return this.#value?{...this.#value}:null;}
  clear():void{this.#value=null;}
}
