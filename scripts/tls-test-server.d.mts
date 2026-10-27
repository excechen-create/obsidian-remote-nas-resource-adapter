export interface LabEvent {server:string;path:string;method:string;authorizationPresent:boolean;closed:boolean;finished:boolean;depth?:string;requestBodyBytes?:number}
export interface TlsLab {
  ca:string;pngBytes:number;state:{events:LabEvent[];streamChunks:number;imageDelay:number};
  certificate(name:'valid-localhost'|'wrong-host'|'expired'):Promise<void>;
  reset():void;
  stats():{events:LabEvent[];streamChunks:number;activeSockets:number};
  close():Promise<void>;
}
export function startTlsLab():Promise<TlsLab>;
