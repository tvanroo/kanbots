const text={type:'string',maxLength:4000},id={type:'string',minLength:1,maxLength:80};
const actor={type:'string',enum:['coordinator','worker','reviewer','user']};
const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const array=(items:unknown,maxItems=100)=>({type:'array',items,maxItems});
export const taskType={type:'string',enum:['research','implementation','qa','release','incident','objective']};
const check=object({id,label:text,mode:{type:'string',enum:['required','advisory','not-applicable']}});
export const workflowConfigSchema=object({
 name:text,
 stages:array(object({id,name:text,purpose:text,entry:text,exit:text,coordinatorGuidance:text,workerGuidance:text,actor,personaId:id,category:{type:'string',enum:['backlog','todo','inProgress','review','done']},checks:array(check,30)},["id","name","purpose","entry","exit","coordinatorGuidance","workerGuidance","actor","category","checks"]),30),
 transitions:array(object({from:id,to:id,actor,automatic:{type:'boolean'},event:{type:'string',enum:['manual','worker-completed','qa-passed','merged','deployed']}}),1000),
 completion:array(object({taskType,guidance:text,checks:array(check,30)}),6),
 waitingReasons:array(text,30),notifications:{type:'string',enum:['meaningful','all-transitions','decisions-only']},
 cadence:object({working:{type:'integer',minimum:1,maximum:1440},idle:{type:'integer',minimum:1,maximum:1440}}),
 releaseOwner:{type:'string',enum:['coordinator','user']},
 template:object({id,version:{type:'integer',minimum:1}}),
},['name','stages','transitions','completion','waitingReasons','notifications','cadence','releaseOwner']);
export const workflowChangeFields={expectedVersion:{type:'integer',minimum:1},config:workflowConfigSchema,reason:text,migrations:array(object({from:id,to:id}),30),moves:array(object({number:{type:'integer',minimum:1},to:id,evidence:text}),1000)};
export const workflowCardFields={priorityStage:id,beforeNumber:{anyOf:[{type:'integer',minimum:1},{type:'null'}]},number:{type:'integer',minimum:1},to:id,taskType,owner:text,nextAction:text,evidence:text,reason:text,checks:array(object({id,outcome:{type:'string',enum:['pass','fail','not-applicable']},evidence:text}),30),waiting:object({reason:text,owner:text,trigger:text}),clearWaiting:{type:'boolean'}};
