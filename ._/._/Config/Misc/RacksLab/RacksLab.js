import SyAPP from "../../../../SyAPP.js";
import SSH from '../../../._/Util/SSH.js'
import ColorText from '../../../._/Util/ColorText.js'
import Qemu from '../../../._/Qemu/Qemu.js'

class RacksLab extends SyAPP.Func(){
    constructor(){
        super('rackslab',
            async (props) => {
                 let uid = props.session.UniqueID

                 if(!this.Storages.Has(uid,'parentfunc')){this.Storages.Set(uid,'parentfunc',props.session.PreviousPath)}

                 if(props.alpine){
                    Qemu.startVM()
                    this.Alert(uid,' ')
                    this.Alert(uid,this.TextColor.green('Alpine lauched !'))
                 }

                 if(props.ubuntu){
                    Qemu.startVM({os : 'ubuntu'})
                    this.Alert(uid,' ')
                    this.Alert(uid,this.TextColor.green('Ubuntu lauched !'))
                 }

                 let racks = await SSH.scanNetwork({background : true,qemu : true})

                 //await this.WaitLog(racks)

                 this.Text(uid,`• Racks Lab | ${racks.cacheAge}`)

                 if(props.connect){
                    await SSH.connect(props.connect)
                 }

                 if(props.unlock){
                    this.Alert(uid,' ')
                    this.Alert(uid,`${ColorText.brightWhite(props.unlock)} unlock requested !`)
                    SSH.fullSetup(props.unlock,'123')
                }   

                 for(let host of racks.hosts){
                    await this.DropDown(uid,host.host,async () => {
                        this.Button(uid,{name : 'Connect',props :{connect : host.host}})
                        if(!host.unlocked){this.Button(uid,{name : 'Unlock',props : {unlock : host.host}})}
                        this.Button(uid,this.TextColor.red('Poweroff'))
                        this.File(uid,{name : host.host})
                    },{up_buttontext : (host.unlocked) ? ColorText.green(host.host) : ColorText.yellow(host.host),
                        down_buttontext :(host.unlocked) ? ColorText.green(host.host) : ColorText.yellow(host.host)
                    })
                 }

                this.Button(uid,' ')
                await this.DropDown(uid,'dropdownlaunch',() => {
                    this.Button(uid,'Alpine',{props : {alpine : true}})
                    this.Button(uid,'Ubuntu',{props : {ubuntu : true}})
                    this.Button(uid,'Custom')
                },{down_buttontext : 'Launch VM',up_buttontext : 'Launch VM',horizontal : true})
                this.Button(uid,' ')
              
                 this.Button(uid,{name :'<- Return',path : this.Storages.Get(uid,'parentfunc')})

            }
        )
    }
}

export default RacksLab